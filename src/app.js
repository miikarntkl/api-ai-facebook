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
    venues: 'PAYLOAD_HELP_VENUES'
};
const locationParameters = {
    city: 'geo-city',
    street: 'street-address',
    country: 'geo-country',
    postalCode: 'zip-code',
};

const defaultCategory = venueCategories.topPicks.name;
const suggestionLimit = 5;
const closestFirst = 0;
var userOptions = {};

const actionFindVenue = 'findVenue';
const intentFindVenue = 'FindVenue';
const actionHelp = 'help';
const intentHelp = 'Help';
const actionStartOver = 'startOver';
const intentStartOver = 'StartOver';
const actionGreetings = 'smalltalk.greetings';
const actionOpenOnly = 'showOpenOnly';
const actionSortByDistance = 'sortByDistance';

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

                console.log('UserOptions Start: ', userOptions);
                if (!isDefined(userOptions[sender])) {
                    userOptions[sender] = {};
                    userOptions[sender].quickRepliesOn = true;
                } else {
                    if (typeof userOptions[sender].quickRepliesOn == 'undefined') {
                        userOptions[sender].quickRepliesOn = true;
                    }
                }

                console.log(action);
                console.log(response.result);

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
                    if (action === actionGreetings) {
                        requestStart(sender, responseText);
                    }
                    else {
                        textResponse(sender, responseText);
                    }
                } else if (isDefined(action) && isDefined(intentName)) {
                    if (action === actionFindVenue && intentName == intentFindVenue) {  //check for findvenue request
                        if (isDefined(parameters)) {
                            findVenue(sender, parameters);
                        }
                    }
                    else if (action === actionHelp && intentName === intentHelp) {        //check for help request
                        helpMessage(sender);
                    }
                    else if (action === actionStartOver && intentName === intentStartOver) {
                        if (userOptions.hasOwnProperty(sender)) {
                            if (userOptions[sender].quickRepliesOn) {
                                deleteUserOptions(sender);
                                requestCategory(sender);
                            }
                            else {
                                requestStart(sender, 'Hey! What are you looking for today?');
                            }
                        }
                    }
                    else if (action === actionOpenOnly) {
                        showOpenOnly(sender);
                    }
                    else if (action === actionSortByDistance) {
                        sortByDistance(sender);
                    }
                }
            }
        });

        apiaiRequest.on('error', (error) => console.error(error));
        apiaiRequest.end();
    }
    else if (event.postback && event.postback.payload) {
        console.log('Executing button action: ', event.postback.payload);
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

function requestStart(sender, message, buttons) {
    console.log('Requesting start!');
    deleteUserOptions(sender);
    requestContinue(sender, message, buttons);
}

function requestContinue(sender, message, buttons) {
    var defaultButtons = [
        {
            content_type: 'text',
            title: 'Start Over',
            payload: 'PAYLOAD_START_OVER',
        },
    ];
    if (!isDefined(message)) {
        message = 'What do you want to do now?';
    }
    if (isDefined(buttons)) {
        try {
            for (let i = 0; i < buttons.length; i++) {
                defaultButtons.unshift(buttons[i]);
            }
        } catch (err) {
            console.log('Start button error: ', err.message);
        }
    }
    var messageData = {
        text: message,
        quick_replies: defaultButtons,
    };
    if (!userOptions[sender].quickRepliesOn) {
        textResponse(sender, message.concat(' ', 'What are you looking for today?'));
    }
    else {
        sendFBMessage(sender, messageData);
    }
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

function requestLocation(sender, message) {
    var defaultMessage = 'Share or type a location:';
    if (isDefined(message)) {
        defaultMessage = message;
    }
    var messageData = {
        text: defaultMessage,
        quick_replies: [
            {
                content_type: 'location',
            }
        ]
    };
    sendFBMessage(sender, messageData);
}

function deleteUserOptions(sender) {
    if (userOptions.hasOwnProperty(sender)) { 
        try {
            delete userOptions[sender].options;
            if (userOptions[sender].quickRepliesOn) {
                delete userOptions[sender].venueType;
            }
            delete userOptions[sender].openOnly;
        } catch (err) {
            console.log('Delete request error: ', err.message);
        }
        console.log('After deletion: ', userOptions);
    } else {
        console.log('Nothing to delete: ', sender);
    }
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
            if (!isDefined(userOptions[sender])) {
                userOptions[sender] = {};
            }
            userOptions[sender].quickRepliesOn = true;
            break;
        case persistentMenu.disable_quick_replies:
            console.log('Disable quick replies');
            if (!isDefined(userOptions[sender])) {
                userOptions[sender] = {};
            }
            userOptions[sender].quickRepliesOn = false;
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

function showOpenOnly(sender) {
    if (isDefined(userOptions[sender])) {
        try {
            if (isDefined(userOptions[sender].options)) {
                userOptions[sender].openOnly = 1;
                userOptions[sender].options.qs.openNow = 1;
                findVenue(sender, null, userOptions[sender].options);
            }
            else textResponse(sender, 'Sorry, I couldn\'t find anything to show.');
        } catch (err) {
            console.log('Open only error: ', err.message);
        }
    }
    else {
        console.log('No saved data for: ', sender);
    }
}

function sortByDistance(sender) {
    if (isDefined(userOptions[sender])) {
        try {
            if (isDefined(userOptions[sender].options)) {
                userOptions[sender].options.qs.sortByDistance = 1;
                findVenue(sender, null, userOptions[sender].options);
            }
        } catch (err) {
            console.log('Open only error: ', err.message);
        }
    }
    else {
        console.log('No saved data for: ', sender);
    }
}

function helpMessage(sender) {
    console.log('Sending help message');
    var messageData;
    if (!userOptions[sender].quickRepliesOn) {
        messageData = 'I\'m VenueBot. I can search for venues by their category or location.\n\n'+
                      'To search by location, type the name of the location or share your location via Facebook Messenger.\n\n'+
                      'To limit the search results by venue category, enter the name of the category.\n\n'+
                      'Supported venue categories are:\nfood, coffee, drinks, shops, arts and top picks.\n\n'+
                      'If you submit only a location, I will give you the top spots of any category in that area.';
    }
    else {
        messageData = 'To get started, type \'start\' or something else along those lines.';
    }
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
        console.log('Invalid Foursquare response');
        return null;
    } 

    var items = raw.response.groups[0].items;
    var venues = [];
    var j = 0;

    if (isDefined(items)) {
        for (let i = 0; i < suggestionLimit && i < items.length; i++) {
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
                var loc = '';
                if (isDefined(venue.location.address)) {
                    loc = loc.concat(venue.location.address);
                }
                if (isDefined(venue.location.postalCode)) {
                    loc = loc.concat(' ', venue.location.postalCode);
                }
                if (isDefined(venue.location.city)) {
                    loc = loc.concat(' ', venue.location.city);
                }
                if (isDefined(venue.location.country)) {
                    loc = loc.concat(' ', venue.location.country);
                }
                if (loc.length < 1 && isDefined(venue.location.lat) && isDefined(venue.location.lng)) {
                    let lat = venue.location.lat;
                    let long = venue.location.lng;
                    loc = lat.toString().concat(',', long.toString());
                }
                if (loc.length > 0) {
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
    console.log('UserOptions: ', userOptions[sender]);

    var venueType = defaultCategory;

    if (isDefined(parameters.venueType)) {
        venueType = parameters.venueType;
    }
    if (userOptions.hasOwnProperty(sender)) {
        console.log('User options found: ', sender);
        if (isDefined(userOptions[sender]) && isDefined(userOptions[sender].venueType)) { //TODO: options save
            venueType = userOptions[sender].venueType;
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

    console.log('VenueType before: ', options.qs.section);


    //city: 'geo-city',
    //street: 'street-address',
    //country: 'geo-country',
    //postalCode: 'zip-code',

    function getLocationString(param) {
        var loc = "";
        if (isDefined(param[locationParameters.street])) {
            console.log('Street found: ', param[locationParameters.street]);
            loc = loc.concat(param[locationParameters.street]);
        }
        if (isDefined(param[locationParameters.postalCode])) {
            console.log('Postal Code found: ', param[locationParameters.postalCode]);
            loc = loc.concat(' ', param[locationParameters.postalCode]);
        }
        if (isDefined(param[locationParameters.city])) {
            if (Array.isArray(param[locationParameters.city]) && param[locationParameters.city].length > 0) {
                console.log('City found: ', param[locationParameters.city]);
                loc = loc.concat(' ', param[locationParameters.city]);
            }
        }
        if (isDefined(param[locationParameters.country])) {
            console.log('Country found: ', param[locationParameters.country]);
            loc = loc.concat(' ', param[locationParameters.country]);
        }
        if (loc.length > 0) {
            return loc;
        } else {
            return null;
        }
    }

    function getCoordinates(param) {
        if (isDefined(param.coordinates.lat) && isDefined(param.coordinates.long)) {
            console.log('Coordinates found');
            let lat = param.coordinates.lat;
            let long = param.coordinates.long;
            if (lat > 90 || lat < -90 || long > 180 || long < -180) {
                return null;
            }
            return lat.toString().concat(', ', long.toString());
        }
        return null;
    }

    if (isDefined(parameters.coordinates)) {
        var coord = getCoordinates(parameters);
        if (isDefined(coord)) {
            console.log('Coordinates set: ', coord);
            options.qs.ll = coord;
        }
    } else {
        var loc = getLocationString(parameters);
        if (isDefined(loc)) {
            console.log('Location set: ', loc);
            options.qs.near = loc;
        } else {
            console.log('No location found');
            options = null;
        }
    }
    if(!isDefined(userOptions[sender])) {
        userOptions[sender] = {};
    }
    if (isDefined(options)) { //!isDefined(userOptions[sender].options
        userOptions[sender].options = options;
    }

    return options;
}

function sendEndQuickReplies(sender) {
    if (userOptions[sender].quickRepliesOn) {
        console.log('Requesting end quick replies');
        let buttons = [];
        if (isDefined(userOptions[sender]) && isDefined(userOptions[sender].options)) {
            if (!isDefined(userOptions[sender].options.qs.openNow)) {
                buttons.push({
                    content_type: 'text',
                    title: 'Show Open Only',
                    payload: 'PAYLOAD_OPEN_ONLY',
                });
            }
            if (!isDefined(userOptions[sender].options.qs.sortByDistance)) {
                buttons.push({
                    content_type: 'text',
                    title: 'Sort By Distance',
                    payload: 'PAYLOAD_SORT_BY_DISTANCE',
                });
            }
            if (buttons.length > 0) {
                requestContinue(sender, null, buttons);
            }
            else {
                requestStart(sender);
            }
        } else {
            requestStart(sender);
        }
    }
    console.log('UserOptions after: ', userOptions[sender]);
}

function findVenue(sender, parameters, savedOptions) {

    var options = null;
    if (!isDefined(savedOptions)) {
        options = formatGETOptions(sender, parameters);
    } else {
        options = savedOptions;
    }

    getVenues(sender, options, (foursquareResponse) => {                 //find venues according to parameters
        if (isDefined(foursquareResponse) && isDefined(foursquareResponse.response)) {

            let formatted = formatVenueData(foursquareResponse);    //format response data for fb

            if (isDefined(formatted) && formatted.length > 0) {
                sendFBGenericMessage(sender, formatted, () => { //send data as fb cards
                    sendEndQuickReplies(sender);
                });
            } else {
                if (!isDefined(userOptions[sender])) {         //ask for location if not provided
                    userOptions[sender] = {};
                }
                userOptions[sender].venueType = parameters.venueType;
                console.log('VenueType after: ', userOptions[sender].venueType);
                requestLocation(sender);              
                console.log('Problem formatting Foursquare data: ', formatted);
            }
        } else {
                if (!isDefined(userOptions[sender])) {
                    userOptions[sender] = {};
                }
                userOptions[sender].venueType = parameters.venueType;
                console.log('VenueType after: ', userOptions[sender].venueType);
                requestLocation(sender);
                console.log('No Foursquare response: ', parameters);
        }
    });
}

function getVenues(sender, options, callback) {
    if (isDefined(options)) {
        console.log('Venue GET Request');
        request(options, (error, res, body) => {  
            if (error) {
                console.error('GET Error: ', error);
            } else {
                try {
                    if (body.meta.errorType === 'failed_geocode') {
                        let index = body.meta.errorDetail.indexOf(':');
                        let loc = '';
                        if (body.meta.errorDetail.length > index) { //get failed location
                            loc = body.meta.errorDetail.substring(index);
                        }
                        requestLocation(sender, 'Sorry, I couldn\'t find'.concat(loc, '.'));
                        console.log('Failed geocode: ', body.meta.errorDetail);
                    }   else {
                            callback(body);
                    }
                } catch (err) {
                    callback(body);
                }
            }
        });
    } else {
        callback(null);
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