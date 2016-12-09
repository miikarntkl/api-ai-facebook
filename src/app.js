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
const venueCategories = {
    food: {
        name: 'food',
        payload: 'PAYLOAD_FOOD'
    },
    drinks: {
        name: 'drinks',
        payload: 'PAYLOAD_DRINKS'
    },
    coffee: {
        name: 'coffee',
        payload: 'PAYLOAD_COFFEE'
    },
    shops: {
        name: 'shops',
        payload: 'PAYLOAD_SHOPS'
    },
    arts: {
        name: 'arts',
        payload: 'PAYLOAD_ARTS'
    },
    topPicks: {
        name: 'topPicks',
        payload: 'PAYLOAD_TOPPICKS'
    }
};
const helpOptions = {
    quick_replies: 'PAYLOAD_HELP_QUICKREPLIES',
    venues: 'PAYLOAD_HELP_VENUES',
};

const defaultCategory = venueCategories.topPicks.name;
var suggestionLimit = 5;
var closestFirst = 0;
var userSearchParameters = {};
var quickRepliesOn = false;

const actionFindVenue = 'findVenue';
const intentFindVenue = 'FindVenue';
const actionHelp = 'help';
const intentHelp = 'Help';

const persistentMenu = {
    help: 'PAYLOAD_HELP',
    enable_quick_replies: 'PAYLOAD_ENABLE_QUICK_REPLIES',
    disable_quick_replies: 'PAYLOAD_DISABLE_QUICK_REPLIES',
};

var chosenCategory = {};

function processEvent(event) {

    var sender = event.sender.id.toString();

    if ((event.message && event.message.text) || (event.message && event.message.attachments)) {
        
        var text = event.message.text;

        if (!isDefined(text) && isDefined(event.message.attachments[0])) { // see if location was sent
            try {
                var lat = event.message.attachments[0].payload.coordinates.lat;
                var long = event.message.attachments[0].payload.coordinates.long;
                text = lat.toString().concat(', ', long.toString());
            } catch(e) {
                console.log('Error with location extraction: ', e.message);
            }
        }

        if (!isDefined(text)) {
            console.log('Error: message text undefined');
            return;
        }

        // Handle a message from this sender

        if (!sessionIds.has(sender)) {
            sessionIds.set(sender, uuid.v1());
        }

        console.log("Text:", text);

        let apiaiRequest = apiAiService.textRequest(text,
            {
                sessionId: sessionIds.get(sender)
            }
        );

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
                    textResponse(sender, responseText);
                } else if (isDefined(action) && isDefined(intentName)) {
                    if (action === actionFindVenue && intentName == intentFindVenue) {  //check for findvenue request
                        if (isDefined(parameters)) {
                            findVenue(sender, parameters);
                        }
                    }

                    else if (action === actionHelp && intentName === intentHelp) {        //check for help request
                        helpMessage(sender);
                    }
                }

            }
        });

        apiaiRequest.on('error', (error) => console.error(error));
        apiaiRequest.end();
    }
    else if (event.postback && event.postback.payload) {
        executeButtonAction(sender, event.postback.payload);
    }
}

function textResponse(sender, str) {
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
            } while (currReverse > prev);
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

function sendFBGenericMessage(sender, messageData, callback) {
    console.log('Sending card message');
    if (!isDefined(messageData)) {
        console.log('GenericMessage content undefined');
        return;
    }
    var cardOptions = {
        url: 'https://graph.facebook.com/v2.6/me/messages',
        qs: {access_token: FB_PAGE_ACCESS_TOKEN},
        method: 'POST',
        json: {
            recipient: {id: sender},
            message: {
                attachment: {
                    type:'template',
                    payload: {
                      template_type:'generic',
                      elements: []
                    }
                }
            }
        }
    };

    for (let i = 0; i < messageData.length; i++) {
        cardOptions.json.message.attachment.payload.elements.push(messageData[i]);
    }

    if (userSearchParameters.hasOwnProperty(sender)) {
        delete userSearchParameters[sender];
        console.log('Deleted: ', userSearchParameters);
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

function requestCategory(sender) { //enables guided UI with quick replies
    var message = {
        text: 'Choose a venue category:',
        quick_replies: [
            {
                content_type: 'text',
                title: 'Food',
                payload: venueCategories.food.payload,
            },
            {
                content_type: 'text',
                title: 'Drinks',
                payload: venueCategories.drinks.payload,
            },
            {
                content_type: 'text',
                title: 'Coffee',
                payload: venueCategories.coffee.payload,
            },
            {
                content_type: 'text',
                title: 'Shops',
                payload: venueCategories.shops.payload,
            },
            {
                content_type: 'text',
                title: 'Arts',
                payload: venueCategories.arts.payload,
            },
            {
                content_type: 'text',
                title: 'Top Picks',
                payload: venueCategories.topPicks.payload,
            },
        ]
    };
    sendFBMessage(sender, message);
}

function requestLocation(sender) {
    var message = {
        text: 'Share or type a location:',
        quick_replies: [
            {
                content_type: 'location',
            }
        ]
    };
    sendFBMessage(sender, message);
}

function executeButtonAction(sender, postback) {
    switch (postback) {
        case persistentMenu.help:
            console.log('Help requested');
            helpMessage(sender);
            break;
        case persistentMenu.enable_quick_replies:
            console.log('Enable quick replies');
            requestCategory(sender);
            quickRepliesOn = true;
            break;
        case persistentMenu.disable_quick_replies:
            console.log('Disable quick replies');
            quickRepliesOn = false;
            break;
        case helpOptions.quick_replies:
            quickReplyHelp(sender);
            console.log('Quick Reply Help');
            break;
        case helpOptions.venues:
            venueHelp(sender);
            console.log('Venue Help');
            break;
        default:
            console.log('No relevant postback found!');
    }
}

function helpMessage(sender) {
    var messageData;
    if (!quickRepliesOn) {
        messageData = 'I can search for multiple types of venues in any location.\n\n'+
                       'To give me a location, type the name of the location or share your location via Messenger.'+
                       'If you submit only a location, I will give the top spots of any category in that area.\n\n'+
                       'To select a type of venue you want, enter the name of the preferred venue type. \n\n'+
                       'Supported venue types are: food, coffee, drinks, shops, arts and top picks.';
    }
    else {
        messageData = 'To get started type \'start\', or something else along those lines';
    }
    console.log('Sender: ', sender);
    console.log('Message: ', messageData);
    textResponse(sender, messageData);
}

function configureThreadSettings(settings, callback) {  //configure FB messenger thread settings
    console.log('Configuring thread settings');         //for now only for adding a simple persistent menu

    var options = {
        url: 'https://graph.facebook.com/v2.6/me/thread_settings',
        qs: {access_token: FB_PAGE_ACCESS_TOKEN},
        method: 'POST',
        json: {
            setting_type: 'call_to_actions',
            thread_state: 'existing_thread',
            call_to_actions: [
                {
                    type: 'postback',
                    title: 'Help',
                    payload: 'PAYLOAD_HELP'
                },
                {
                    type: 'postback',
                    title: 'Enable Quick Replies',
                    payload: 'PAYLOAD_ENABLE_QUICK_REPLIES'
                },
                {
                    type: 'postback',
                    title: 'Disable Quick Replies',
                    payload: 'PAYLOAD_DISABLE_QUICK_REPLIES'
                }
            ]
        }
    };

    request(options, (error, response, body) => {
        if (error) {
            console.log('Error configuring thread settings: ', error);
        } else if (response.body.error) {
            console.log('Error: ', response.body.error);
        }
        if (callback) {
            callback();
        }
    });
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

function formatVenueData(raw) {
    if (!isDefined(raw.response.groups)) {
        return null;
    }
    var items = raw.response.groups[0].items;
    var venues = [];
    var j = 0;

    if (isDefined(items)) {
        for (let i = 0; i < suggestionLimit; i++) {
            var venue = items[i].venue;

            //add venue name
            var formatted = {};
            if (!isDefined(venue.name) || !isDefined(venue.id)) {
                continue;
            }
            formatted.title = venue.name;

            //add venue photo
            if (venue.photos.count > 0 && isDefined(venue.photos.groups[0])) {
                let prefix = venue.photos.groups[0].items[0].prefix;
                let suffix = venue.photos.groups[0].items[0].suffix;
                let original = 'original';
                formatted.image_url = prefix.concat(original, suffix);
            }

            //add venue hours
            if (isDefined(venue.hours) && isDefined(venue.hours.status)) {
                formatted.subtitle = venue.hours.status;
            } else {
                formatted.subtitle = '';
            }

            formatted.buttons = [];
            j = 0;

            //add link to venue
            formatted.buttons[j] = {
                type: 'web_url',
                title: 'View Website',
            };

            if (isDefined(venue.url)) {
                formatted.buttons[j].url = venue.url;
                j++;
            } else {
                formatted.buttons[j].url = 'http://foursquare.com/v/'.concat(venue.id);
                j++;
            }

            //add link to venue's location on google maps
            if (isDefined(venue.location)) {
                var loc = null;
                if (isDefined(venue.location.address) && isDefined(venue.location.city)) {
                    loc = venue.location.address.concat(' ', venue.location.city);
                    if (isDefined(venue.location.postalCode)) {
                        loc = loc.concat(' ', venue.location.postalCode);
                    }
                    if (isDefined(venue.location.country)) {
                        loc = loc.concat(' ', venue.location.country);
                    }
                }
                if (!isDefined(loc) && isDefined(venue.location.lat) && isDefined(venue.location.lng)) {
                    let lat = venue.location.lat;
                    let long = venue.location.lng;
                    loc = lat.toString().concat(',', long.toString());
                }
                if (isDefined(loc)) {
                    formatted.buttons[j] = {
                        type: 'web_url',
                        title: 'Show On Map',
                    };
                    formatted.buttons[j].url = 'http://maps.google.com/?q='.concat(loc);
                    j++;
                }
            }
            venues.push(formatted);
        }
    }
    return venues;
}

function formatGETOptions(sender, parameters) {
    console.log(userSearchParameters);

    var venueType = defaultCategory;

    if (isDefined(parameters.venueType)) {
        venueType = parameters.venueType;
    }
    if (userSearchParameters.hasOwnProperty(sender)) {
        console.log('Same sender: ', sender);
        if (isDefined(userSearchParameters[sender])) {
            venueType = userSearchParameters[sender];
        }
    }

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
            venuePhotos: 1,
        },
        json: true,
    };

    console.log('VenueType: ', venueType);
    console.log('Venue: ', options.qs.section);

    var loc = null;
    if (isDefined(parameters.location)) {
        console.log('Location defined');
        if (isDefined(parameters.location.location)) { //location as address
            options.qs.near = parameters.location.location;
        }
    } else if (isDefined(parameters.coordinates) && isDefined(parameters.coordinates.lat) && isDefined(parameters.coordinates.long)) {
        console.log('Coordinates defined'); //location as coordinates
        let lat = parameters.coordinates.lat;
        let long = parameters.coordinates.long;
        if (lat > 90 || lat < -90 || long > 180 || long < -180) {
            return null;
        }
        options.qs.ll = lat.toString().concat(', ', long.toString());
    } else {
        return null;
    }

    return options;
}

function findVenue(sender, parameters) {
    getVenues(sender, parameters, (foursquareResponse) => {                 //find venues according to parameters
        if (isDefined(foursquareResponse) && isDefined(foursquareResponse.response)) {
            let formatted = formatVenueData(foursquareResponse);    //format response data for fb
            if (isDefined(formatted) && formatted.length > 0) {
                sendFBGenericMessage(sender, formatted);               //send data as fb cards
            } else {
                userSearchParameters[sender] = foursquareResponse;
                requestLocation(sender);              //ask for location if not provided
                console.log('ID: ', sender);
                console.log('TYPE: ', userSearchParameters.sender);
            }
        } else {
                userSearchParameters[sender] = foursquareResponse;
                requestLocation(sender);
                console.log('ID: ', sender);
                console.log('TYPE: ', userSearchParameters.sender);
        }
    });
}

function getVenues(sender, parameters, callback) {

    var options = formatGETOptions(sender, parameters);

    if (isDefined(options)) {
        request(options, (error, res, body) => {  
            if (error) {
                console.error('GET Error: ', error);
            } else {
                callback(body);
            }
        });
    } else {
        callback(parameters.venueType);
    }
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
                            console.log('Processing event');
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
        console.log('Webhook error: ', err.message);
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
configureThreadSettings(null);