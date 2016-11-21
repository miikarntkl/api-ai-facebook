'use strict';

const apiai = require('apiai');
const express = require('express');
const bodyParser = require('body-parser');
const uuid = require('node-uuid');
const request = require('request');
const JSONbig = require('json-bigint');
const async = require('async');

const REST_PORT = (process.env.PORT || 5000);
const APIAI_ACCESS_TOKEN = process.env.APIAI_ACCESS_TOKEN;
const APIAI_LANG = process.env.APIAI_LANG || 'en';
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const FS_CLIENT_SECRET = process.env.FS_CLIENT_SECRET;
const FS_CLIENT_ID = process.env.FS_CLIENT_ID;

const apiAiService = apiai(APIAI_ACCESS_TOKEN, {language: APIAI_LANG, requestSource: "fb"});
const sessionIds = new Map();

const foursquareVersion = '20160108';
const foursquareCategories = {
    food: 'food',
    drinks: 'drinks',
    coffee: 'coffee',
    shops: 'shops',
    arts: 'arts',
    topPicks: 'topPicks',
};
const defaultCategory = foursquareCategories.topPicks;
var suggestionLimit = 3;
var closestFirst = 0;

const actionFindVenue = 'findVenue';
const intentFindVenue = 'FindVenue';

function processEvent(event) {
    var sender = event.sender.id.toString();

    if ((event.message && event.message.text) || (event.postback && event.postback.payload)) {
        var text = event.message ? event.message.text : event.postback.payload;
        // Handle a text message from this sender

        if (!sessionIds.has(sender)) {
            sessionIds.set(sender, uuid.v1());
        }

        console.log("Text:", text);

        let apiaiRequest = apiAiService.textRequest(text,
            {
                sessionId: sessionIds.get(sender)
            });

        apiaiRequest.on('response', (response) => {
            if (isDefined(response.result)) {
                let responseText = response.result.fulfillment.speech;
                let responseData = response.result.fulfillment.data;
                var action = response.result.action;
                var intentName = response.result.metadata.intentName;
                var parameters = response.result.parameters;

                console.log(action);

                if (isDefined(responseData) && isDefined(responseData.facebook)) {
                    if (!Array.isArray(responseData.facebook)) {
                        try {
                            console.log('Response as formatted message');
                            sendFBMessage(sender, responseData.facebook);
                        } catch (err) {
                            sendFBMessage(sender, {text: err.message});
                        }
                    } else {
                        async.eachSeries(responseData.facebook, (facebookMessage, callback) => {
                            try {
                                if (facebookMessage.sender_action) {
                                    console.log('Response as sender action');
                                    sendFBSenderAction(sender, facebookMessage.sender_action, callback);
                                }
                                else {
                                    console.log('Response as formatted message');
                                    sendFBMessage(sender, facebookMessage, callback);
                                }
                            } catch (err) {
                                sendFBMessage(sender, {text: err.message}, callback);
                            }
                        });
                    }
                } else if (isDefined(responseText)) {
                    textResponse(responseText, sender);
                } else if (isDefined(action) && isDefined(intentName)) {

                    if (action === actionFindVenue && intentName == intentFindVenue) {
                        if (isDefined(parameters)) {
                            findVenue(parameters, (foursquareResponse) => {
                                if (isDefined(foursquareResponse)) {
                                    console.log('Response is defined');
                                    sendFBCardMessage(sender, formatVenueData(foursquareResponse));
                                }
                            });
                        }
                    }
                }

            }
        });

        apiaiRequest.on('error', (error) => console.error(error));
        apiaiRequest.end();
    } /*else if (event.message && event.message.attachments) { //handle fb location sharing
        if (isDefined(event.message.attachments[0].payload) && isDefined(event.message.attachments[0].payload.coordinates)) {
            if (isDefined(event.message.attachments[0].payload.coordinates.lat) && isDefined(event.message.attachments[0].payload.coordinates.long)) {
                passCoordinates(sender, event.message.attachments[0].payload.coordinates);
            }
        }
    }*/
}

function passCoordinates(sender, coordinates) {
    console.log('Location made through!');
    parameters = {};
    parameters.location = {};
    parameters.location.coordinates = coordinates;
    console.log(isDefined(parameters.location.coordinates));
    console.log(parameters.location.coordinates.lat);
    console.log(parameters.location.coordinates.long);
}

function textResponse(str, sender) {
    console.log('Response as text message');
        // facebook API limit for text length is 320,
        // so we must split message if needed
    var splittedText = splitResponse(str);

    async.eachSeries(splittedText, (textPart, callback) => {
        sendFBMessage(sender, {text: textPart}, callback);
    });
}

function splitResponse(str) {
    if (str.length <= 320) {
        return [str];
    }

    return chunkString(str, 300);
}

function chunkString(s, len) {
    var curr = len, prev = 0;

    var output = [];

    while (s[curr]) {
        if (s[curr++] == ' ') {
            output.push(s.substring(prev, curr));
            prev = curr;
            curr += len;
        }
        else {
            var currReverse = curr;
            do {
                if (s.substring(currReverse - 1, currReverse) == ' ') {
                    output.push(s.substring(prev, currReverse));
                    prev = currReverse;
                    curr = currReverse + len;
                    break;
                }
                currReverse--;
            } while (currReverse > prev)
        }
    }
    output.push(s.substr(prev));
    return output;
}

function sendFBMessage(sender, messageData, callback) {
    request({
        url: 'https://graph.facebook.com/v2.6/me/messages',
        qs: {access_token: FB_PAGE_ACCESS_TOKEN},
        method: 'POST',
        json: {
            recipient: {id: sender},
            message: messageData
        }
    }, (error, response, body) => {
        if (error) {
            console.log('Error sending message: ', error);
        } else if (response.body.error) {
            console.log('Error: ', response.body.error);
        }

        if (callback) {
            callback();
        }
    });
}

function sendFBCardMessage (sender, messageData, callback) {
    console.log('Sending card message: ');
    console.log(messageData);

    var cardOptions = {
        url: 'https://graph.facebook.com/v2.6/me/messages',
        qs: {access_token: FB_PAGE_ACCESS_TOKEN},
        method: 'POST',
        json: {
            recipient: {id: sender},
            message: {
                'attachment': {
                    'type':'template',
                    'payload': {
                      'template_type':'generic',
                      'elements':[]
                    }
                }
            }
        }
    };

    for (let i = 0; i < suggestionLimit; i++) {
        cardOptions.json.message.attachment.payload.elements.push(messageData[i]);
    }

    request(cardOptions, (error, response, body) => {
        if (error) {
            console.log('Error sending card: ', error);
        } else if (response.body.error) {
            console.log('Error: ', response.body.error);
        }

        if (callback) {
            callback();
        }
    });
}

function sendFBSenderAction(sender, action, callback) {
    setTimeout(() => {
        request({
            url: 'https://graph.facebook.com/v2.6/me/messages',
            qs: {access_token: FB_PAGE_ACCESS_TOKEN},
            method: 'POST',
            json: {
                recipient: {id: sender},
                sender_action: action
            }
        }, (error, response, body) => {
            if (error) {
                console.log('Error sending action: ', error);
            } else if (response.body.error) {
                console.log('Error: ', response.body.error);
            }
            if (callback) {
                callback();
            }
        });
    }, 1000);
}

function doSubscribeRequest() {
    request({
            method: 'POST',
            uri: "https://graph.facebook.com/v2.6/me/subscribed_apps?access_token=" + FB_PAGE_ACCESS_TOKEN
        },
        (error, response, body) => {
            if (error) {
                console.error('Error while subscription: ', error);
            } else {
                console.log('Subscription result: ', response.body);
            }
        });
}

function isDefined(obj) {
    if (typeof obj == 'undefined') {
        return false;
    }

    if (!obj) {
        return false;
    }

    return obj != null;
}

const app = express();

app.use(bodyParser.text({type: 'application/json'}));

app.get('/webhook/', (req, res) => {
    if (req.query['hub.verify_token'] == FB_VERIFY_TOKEN) {
        res.send(req.query['hub.challenge']);

        setTimeout(() => {
            doSubscribeRequest();
        }, 3000);
    } else {
        res.send('Error, wrong validation token');
    }
});

app.post('/webhook/', (req, res) => {
    try {
        var data = JSONbig.parse(req.body);

        if (data.entry) {
            let entries = data.entry;
            entries.forEach((entry) => {
                let messaging_events = entry.messaging;
                if (messaging_events) {
                    messaging_events.forEach((event) => {
                        if (event.message && !event.message.is_echo ||
                            event.postback && event.postback.payload) {
                            processEvent(event);
                        }
                    });
                }
            });
        }

        return res.status(200).json({
            status: "ok"
        });
    } catch (err) {
        return res.status(400).json({
            status: "error",
            error: err
        });
    }

});

app.listen(REST_PORT, () => {
    console.log('Rest service ready on port ' + REST_PORT);
});

doSubscribeRequest();

function formatVenueData(raw) {
    var items = raw.response.groups[0].items;
    var venues = [];
    var j = 0;

    if (isDefined(items)) {
        for (let i = 0; i < suggestionLimit; i++) {
            var venue = items[i].venue;
            var url = venue.url;

            var formatted = {};
            formatted.title = venue.name;

            if (isDefined(venue.hours) && isDefined(venue.hours.status)) {
                formatted.subtitle = venue.hours.status;
            } else {
                formatted.subtitle = '';
            }

            formatted.buttons = [];
            j = 0;

            formatted.buttons[j] = {
                type: 'web_url',
                title: 'View Website',
            };

            if (isDefined(url)) {
                formatted.buttons[j].url = url;
                j++;
            } else {
                formatted.buttons[j].url = 'http://foursquare.com/v/'.concat(venue.id);
                j++;
            }

            formatted.buttons[j] = {
                type: 'web_url',
            };
            if (isDefined(venue.location) && isDefined(venue.location.formattedAddress && venue.location.formattedAddress.length > 1)) {
                formatted.buttons[j].title = venue.location.formattedAddress[0].concat(', ', venue.location.formattedAddress[1]);
            } else {
                formatted.buttons[j].title = venue.location.city;
            }
            formatted.buttons[j].url = 'http://maps.google.com/?q='.concat(formatted.buttons[j].title);

            venues.push(formatted);
        }
    }
    return venues;
}

function formatGETOptions(parameters) {

    var venueType = defaultCategory;

    if (!isDefined(parameters.venueType)) {
        venueType = parameters.venueType;
    }

    console.log(defaultCategory);
    console.log('Address: ', isDefined(parameters.location));
    console.log('Coordinates: ', isDefined(parameters.coordinates));
    console.log('Venue: ', isDefined(parameters.venueType));

    var options = {
        method: 'GET',
        url: 'http://api.foursquare.com/v2/venues/explore',
        qs: {
            client_id: FS_CLIENT_ID,
            client_secret: FS_CLIENT_SECRET,
            v: foursquareVersion,
            m: 'foursquare',
            section: venueType,
            limit: suggestionLimit,
            sortByDistance: closestFirst,
        },
        venuePhotos: 1,
        json: true,
    };

    console.log('Venue: ', options.qs.section);


    if (!isDefined(parameters.location)) {
        console.log('Location defined');
        if (isDefined(parameters.location.location)) { //location as address
            console.log('Location.location defined');
            options.qs.near = parameters.location.location;
        }
    } else if (isDefined(parameters.coordinates)) { //location as coordinates
        console.log('Coordinates defined');
        options.qs.ll = parameters.location.coordinates.lat.concat(', ', parameters.location.coordinates.long);
    } else {
        return null;
    }

    console.log('Location: ', options.qs.ll);

    return options;
}

function findVenue(parameters, callback) {

    var options = formatGETOptions(parameters);

    if (isDefined(options)) {
        request(options, (error, res, body) => {  
            if (error) {
                console.error('GET Error: ', error);
            } else {
                callback(body);
            }
        });
    }
}