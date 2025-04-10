import WebSocket from 'ws';
import fetch from 'node-fetch';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import * as fs from 'fs';
import path from 'path';

dotenv.config();

let OAUTH_TOKEN = process.env.TWITCH_ACCESS_TOKEN_BOT;
let REFRESH_TOKEN = process.env.TWITCH_REFRESH_TOKEN_BOT; 
const CLIENT_ID = process.env.TWITCH_CLIENT_ID_BOT;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET_BOT;

const BROADCASTER_ID = process.env.TWITCH_BROADCASTER_ID; // Broadcaster ID (your channel)
const EVENTSUB_WEBSOCKET_URL = 'wss://eventsub.wss.twitch.tv/ws';
const BOT_USER_ID = process.env.BOT_USER_ID; // Same as BROADCASTER_ID

// Socials media links
const INSTAGRAM_URL = process.env.INSTAGRAM_URL;
const YOUTUBE_URL = process.env.YOUTUBE_URL;
const VOD_URL = process.env.VOD_URL;
const DISCORD_URL = process.env.DISCORD_URL;
const X_URL = process.env.X_URL;
const TIKTOK_URL = process.env.TIKTOK_URL;

// Charger les mots négatifs depuis le JSON
const pejorativeWords = JSON.parse(fs.readFileSync('pejorative_words.json', 'utf-8')).pejorative_words;
const pejorativeRegex = new RegExp(`\\b(${pejorativeWords.map(word => word.trim().replace(/\s+/g, '\\s*')).join('|')})\\b`, 'i');

// List of prompts for openAI
const prompts = JSON.parse(fs.readFileSync('prompts.json', 'utf-8'));
const viewerLanguageFile = 'viewer_language.json';
let viewerLanguage = JSON.parse(fs.readFileSync(viewerLanguageFile, 'utf-8'));

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

let ws; // WebSocket instance
let websocketSessionId;

const messageQueue = [];
let isProcessingQueue = false;

const userCooldowns = new Map();
const userLastQuestions = new Map(); // Tracks the last question asked by each user
const QUESTION_EXPIRATION_TIME = 60000; // Time in milliseconds (1 minute). Duration after which a user's last question is considered "expired."
const COOLDOWN_TIME = 5000; // Cooldown time in milliseconds (5 seconds). Minimum delay required between messages from the same user to prevent spamming.
const BOT_ANNOUNCEMENT_INTERVAL = 278000; // Interval in milliseconds (4 minutes and 38 seconds). Time between bot announcements in the chat.

// Start the bot
(async () => {
    await validateToken(); // Validate the OAuth token
    startWebSocketConnection(); // Start the WebSocket connection
    startBotAnnouncement(); // Start sending periodic bot announcements
})();

// Validate the OAuth token
async function validateToken() {
    const response = await fetch('https://id.twitch.tv/oauth2/validate', {
        headers: {
            'Authorization': `OAuth ${OAUTH_TOKEN}`,
        },
    });

    if (!response.ok) {
        console.error('Invalid OAuth token. Attempting to refresh...');
        await refreshAccessToken();
    } else {
        console.log('OAuth token is valid.');
    }
}

// Refresh the OAuth token
async function refreshAccessToken() {
    try {
        const response = await fetch('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'refresh_token',
                refresh_token: REFRESH_TOKEN
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Error during refresh: ${errorData.message}`);
        }

        const data = await response.json();
        OAUTH_TOKEN = data.access_token;
        REFRESH_TOKEN = data.refresh_token;

        console.log('Token successfully refreshed ✅');

        // Update the .env file
        let envContent = fs.readFileSync('.env', 'utf-8');
        envContent = envContent
            .replace(/TWITCH_ACCESS_TOKEN_BOT=.*/, `TWITCH_ACCESS_TOKEN_BOT=${OAUTH_TOKEN}`)
            .replace(/TWITCH_REFRESH_TOKEN_BOT=.*/, `TWITCH_REFRESH_TOKEN_BOT=${REFRESH_TOKEN}`);
        fs.writeFileSync('.env', envContent);
        console.log('.env updated');
    } catch (error) {
        console.error('Error refreshing the token:', error.message);
        process.exit(1); // Stop the bot if unable to refresh
    }
}

// Start the WebSocket connection
function startWebSocketConnection(url = EVENTSUB_WEBSOCKET_URL) {
    ws = new WebSocket(url);

    ws.on('open', () => {
        console.log('WebSocket connection established.');
    });

    ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        handleWebSocketMessage(message);
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });

    ws.on('close', () => {
        console.log('WebSocket connection closed.');
        // Try to reconnect
        setTimeout(() => {
            console.log('Attempting to reconnect...');
            startWebSocketConnection();  // Auto reconnect
        }, 5000); // Wait 5 sec
    });

    // Ajouter un gestionnaire pour les pongs
    ws.on('pong', () => {
        console.log('Pong received.');
    });
}

function startBotAnnouncement() {
    const announcementMessage = prompts.bot_announcement;

    if (!announcementMessage) {
        console.error("Bot announcement message is not defined in prompts.json.");
        return;
    }

    setInterval(() => {
        sendChatMessage(announcementMessage); // Send the announcement message to the chat
    }, BOT_ANNOUNCEMENT_INTERVAL);
}

// Function to get the file name based on the current date
function getLogFileName() {
    const date = new Date().toLocaleDateString('fr-FR').split('/').join('-'); // Format DD-MM-YYYY
    return path.join('logs', `${date}.txt`); // Store logs in a "logs" folder
}

// Function to add a log entry to logs.txt
function logMessage(user, message, response) {
    const timestamp = new Date().toLocaleString(); // Readable format
    const logEntry = `[${timestamp}] ${user}: ${message} \nBOT: ${response}\n\n`;

    // Get the file for the current day
    const logFile = getLogFileName();

    // Ensure the "logs" folder exists
    if (!fs.existsSync('logs')) {
        fs.mkdirSync('logs');
    }    

    // Add the log entry to the file for the current day
    fs.appendFileSync(logFile, logEntry, 'utf8');
}

// Cooldown system for users. Prevents spamming by requiring a minimum delay (defined by COOLDOWN_TIME) between messages from the same user.
function canUserSendMessage(user) {
    const now = Date.now();
    if (userCooldowns.has(user) && now - userCooldowns.get(user) < COOLDOWN_TIME) {
        return false; // User is still in cooldown
    }
    userCooldowns.set(user, now); // Update the user's last message timestamp
    return true;
}

// Processes messages in the queue one by one. Ensures that messages are handled sequentially to avoid overloading the bot or APIs. Automatically starts processing if the queue is not empty.
async function processMessageQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;

    isProcessingQueue = true;

    while (messageQueue.length > 0) {
        const { question, sender, messageId } = messageQueue.shift(); // Retrieves the first message from the queue
        try {
            await handleBotCommand(question, sender, messageId); // Processes the message
        } catch (error) {
            console.error(`Error processing message from ${sender}:`, error);
        }
    }

    isProcessingQueue = false;
}

// Adds a message to the processing queue. Ensures that users respect a cooldown period before sending another message. If a user sends messages too quickly, they are notified to wait before asking again.
function enqueueMessage(question, sender, messageId) {
    const now = Date.now();
    // Check if the user is in cooldown
    if (!canUserSendMessage(sender)) {
        console.log(`User ${sender} is sending messages too quickly.`);
        sendChatMessage(`Patiente un peu avant de poser une autre question, ${sender} !`, messageId);
        return;
    }

    // Check if the question is identical and recent
    if (userLastQuestions.has(sender)) {
        const { lastQuestion, timestamp } = userLastQuestions.get(sender);
        if (lastQuestion === question && now - timestamp < QUESTION_EXPIRATION_TIME) {
            console.log(`User ${sender} asked the same question recently: "${question}"`);
            sendChatMessage(`You already asked this question recently, ${sender}! 😊`, messageId);
            return;
        }
    }

    // Update the user's last question with a timestamp
    userLastQuestions.set(sender, { lastQuestion: question, timestamp: now });

    messageQueue.push({ question, sender, messageId });
    processMessageQueue(); // Starts processing if it is not already in progress
}

// Handle WebSocket messages
async function handleWebSocketMessage(message) {
    switch (message.metadata.message_type) {
        case 'session_welcome':
            websocketSessionId = message.payload.session.id;
            subscribeToChatEvents(); // Subscribe to chat events
            break;

        case 'session_reconnect':
            const reconnectUrl = message.payload.session.reconnect_url;
            console.log('Session reconnect requested. Reconnecting...');
            if (ws) {
                ws.close(); // Close the current WebSocket connection
            }
            startWebSocketConnection(reconnectUrl);
            break;
        
        case 'keepalive':
            console.log('Keepalive received, connection is healthy.');
            break;

        case 'notification':
            if (message.metadata.subscription_type === 'channel.chat.message') {
                const chatMessage = message.payload.event.message.text;// Retrieve the chat message
                const sender = message.payload.event.chatter_user_login; // Retrieve the sender's username
                const messageId = message.payload.event.message_id; // Retrieve the message ID

                if (chatMessage.startsWith('!brigadier')) {
                    const question = chatMessage.replace('!brigadier', '').trim();
                    enqueueMessage(question, sender, messageId);
                } else if (chatMessage.trim() === '!titre') { // Check for the "!titre" command
                    const streamTitle = await getStreamTitle(); // Fetch the stream title
                    sendChatMessage(`Titre du stream : ${streamTitle}`, messageId); // Send the title as a response
                }
            }
            break;

        case 'ping':
            console.log('Ping received, sending a pong...');
            ws.send(JSON.stringify({ type: 'pong' })); // Respond with a pong
            break;
    }
}

// Subscribe to chat events
async function subscribeToChatEvents() {
    const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OAUTH_TOKEN}`,
            'Client-Id': CLIENT_ID,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            type: 'channel.chat.message',
            version: '1',
            condition: {
                broadcaster_user_id: BROADCASTER_ID,
                user_id: BOT_USER_ID,  // Added bot ID required by Twitch
            },
            transport: {
                method: 'websocket',
                session_id: websocketSessionId,
            },
        }),
    });

    if (!response.ok) {
        console.error('Error subscribing to EventSub:', await response.text());
    } else {
        console.log('EventSub subscription successful.');
    }
}

function truncateMessage(message, maxLength = 500) {
    if (message.length <= maxLength) {
        return message;
    }
    // Truncate and add ellipsis
    return message.slice(0, maxLength).trim() + '...';
}

// Send a message to the chat
async function sendChatMessage(message, messageId = null) {
    try {
        // Truncate the message if it exceeds 500 characters
        message = truncateMessage(message);

        // Prepare the body of the request
        const body = {
            broadcaster_id: BROADCASTER_ID,
            sender_id: BOT_USER_ID,
            message: message,
        };

        // If replying to a specific message, include the parent message ID
        if (messageId) {
            body.reply_parent_message_id = messageId;
        }

        // First attempt to send the message
        const response = await fetch('https://api.twitch.tv/helix/chat/messages', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OAUTH_TOKEN}`,
                'Client-Id': CLIENT_ID,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorData = await response.json();

            // If the error is "Unauthorized" (invalid OAuth token)
            if (response.status === 401 && errorData.message === "Invalid OAuth token") {
                console.warn('Invalid OAuth token detected. Attempting to refresh...');
                await refreshAccessToken(); // Refresh the token

                // Retry sending the message with the new token
                const retryResponse = await fetch('https://api.twitch.tv/helix/chat/messages', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${OAUTH_TOKEN}`,
                        'Client-Id': CLIENT_ID,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(body),
                });

                if (!retryResponse.ok) {
                    console.error('Error sending the message after token refresh:', await retryResponse.text());
                } else {
                    console.log('Message sent successfully after token refresh:', message);
                }
            } else {
                console.error('Error sending the message:', errorData);
            }
        } else {
            console.log('Message sent successfully:', message);
        }
    } catch (error) {
        console.error('Unexpected error while sending the message:', error);
    }
}

// Function to assign a language to a viewer
function assignLanguageToViewer(viewer) {
    if (!viewerLanguage[viewer]) {
        // Choisir un type de langage aléatoire (représenté par un chiffre)
        const randomLanguage = Math.floor(Math.random() * 3) + 1; // 1, 2 ou 3
        viewerLanguage[viewer] = randomLanguage;

        // Sauvegarder dans le fichier JSON
        fs.writeFileSync(viewerLanguageFile, JSON.stringify(viewerLanguage, null, 2), 'utf-8');
        console.log(`Assigned language "${randomLanguage}" to viewer "${viewer}".`);
    }

    return viewerLanguage[viewer];
}

/**
 * Handles a command or question sent to the bot.
 * Determines the type of question or command and processes it accordingly.
 * Supports various types of interactions, such as responding to user questions,
 * providing information about the stream, or handling specific bot commands.
 * 
 * @param {string} question - The question or command sent by the user.
 * @param {string} sender - The username of the person who sent the message.
 * @param {string} messageId - The ID of the message (used for replying in chat).
 * @returns {Promise<void>} - Resolves when the command has been processed.
 */
async function handleBotCommand(question, sender, messageId) {
    // Assigner un type de langage au viewer s'il n'en a pas déjà un
    const languageCode = assignLanguageToViewer(sender);
    const language = prompts.language_styles[languageCode]; // Convertir le code en style de langage

    // Checks if the message is empty or contains 3 characters or less
    if (!question || question.trim().length <= 3) {
        const fallbackResponse = "Tu devrais poser une question plus complète ! 😊";
        sendChatMessage(fallbackResponse, messageId);
        logMessage(sender, question, fallbackResponse);
        return;
    }

    let response;

    try {
        if (pejorativeRegex.test(question)) {
            response = await getOpenAIResponse(question, language);
        } else if (isStreamQuestion(question)) {
            const schedule = await getTwitchSchedule();
            response = await askOpenAIAboutSchedule(question, language, schedule);
        } else if (isChonchQuestion(question)) {
            response = await askOpenAIAboutChonch(question);
        } else if (isSocialMediaQuestion(question, language)) {
            response = await askOpenAIAboutSocials(question);
        } else if (isSubscriptionQuestion(question, language)) {
            response = await askOpenAIAboutSubscription(question);
        } else if (isTopClipsQuestion(question)) {
            const clipsInfo = await getTopClips();
            response = await askOpenAIAboutClips(question, language, clipsInfo);
        } else {
            response = await getOpenAIResponse(question, language);
        }

        sendChatMessage(response, messageId);
        logMessage(sender, question, response);

    } catch (error) {
        console.error("Error in handleBotCommand:", error);
        
        const errorResponse = "Je n'arrive pas à répondre à la question pour le moment. 😕";
        sendChatMessage(errorResponse, messageId);
        
        logMessage(sender, question, errorResponse + " | Error: " + error.message);
    }
}

// Function to get the current stream title
async function getStreamTitle() {
    try {
        const response = await fetch(`https://api.twitch.tv/helix/streams?user_id=${BROADCASTER_ID}`, {
            headers: {
                'Authorization': `Bearer ${OAUTH_TOKEN}`,
                'Client-Id': CLIENT_ID,
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch stream title: ${response.statusText}`);
        }

        const data = await response.json();
        const stream = data.data[0]; // The first item contains the stream info

        if (stream) {
            return stream.title; // Return the stream title
        } else {
            return "Le stream est actuellement hors ligne."; // Message if the stream is offline
        }
    } catch (error) {
        console.error("Error fetching stream title:", error);
        return "Impossible de récupérer le titre du stream pour le moment.";
    }
}

function buildPrompt(options = {}) {
    const { profile = prompts.profile, language, question, additionalInfo = '' } = options;

    return `${profile}
    Le type de langage utilisé pour répondre est : ${language}.
    ${additionalInfo}
    Voici la question du viewer : 
    ${question}`;
}

// Function to get a response from OpenAI
async function getOpenAIResponse(question, language) {
    const additionalInfo = prompts.negative;
    const prompt = buildPrompt({
        language,
        question,
        additionalInfo
    });

    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
    });

    return response.choices[0].message.content;
}

async function getTwitchSchedule() {
    const response = await fetch(`https://api.twitch.tv/helix/schedule?broadcaster_id=${BROADCASTER_ID}`, {
        headers: {
            'Authorization': `Bearer ${OAUTH_TOKEN}`,
            'Client-Id': CLIENT_ID,
        },
    });

    const data = await response.json();
    return data.data.segments || [];
}

async function askOpenAIAboutSchedule(question, language, schedule) {
    const additionalInfo = `Voici les horaires de streaming, tu dois convertir les heures en GMT+1: ${JSON.stringify(schedule)}`;
    const prompt = buildPrompt({
        language,
        question,
        additionalInfo
    });

    const openaiResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
    });

    return openaiResponse.choices[0].message.content.trim();
}

// Check if a message contains a question about the schedule or stream
function isStreamQuestion(message) {
    const regex = /(proch(a|ai)n|quand|heure|jeu[x]?|plann?ing|stream|à quelle heure|live)/i;

    return regex.test(message);
}

async function askOpenAIAboutSocials(question, language) {
    const additionalInfo = `Voici les liens vers les réseaux sociaux de la chaine:
    Instagram: ${INSTAGRAM_URL}
    YouTube: ${YOUTUBE_URL}
    VOD: ${VOD_URL}
    Tiktok: ${TIKTOK_URL}
    Discord: ${DISCORD_URL}
    X et twitter: ${X_URL}`;

    const prompt = buildPrompt({
        language,
        question,
        additionalInfo
    });

    const openaiResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
    });

    return openaiResponse.choices[0].message.content.trim();
}

// Check if a message contains a question about social media
function isSocialMediaQuestion(message) {
    const socialKeywords = ['instagram', 'youtube', 'réseaux sociaux', 'page instagram', 'page youtube', 'insta', 'vod', 'ytb', 'chaine'];
    return socialKeywords.some(keyword => message.toLowerCase().includes(keyword));
}

// Function to ask OpenAI about subscriptions
async function askOpenAIAboutSubscription(question) {
    const additionalInfo = `Voici les avantages de l'abonnement à la chaîne :
        Essaie de convaincre en quelques mots pourquoi s'abonner à la chaîne. Mentionne les avantages suivants sans en rajouter ni faire de supposition :
        - De nouveaux emojis exclusifs.
        - Moins de publicités pendant les streams.
        - Un soutien direct à la chaîne et au créateur de contenu.

        Sois persuasif et donne une réponse convaincante !`;

    const prompt = buildPrompt({
        language,
        question,
        additionalInfo
    });

    const openaiResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
    });

    return openaiResponse.choices[0].message.content.trim();
}

// Function to check if the message contains a question about subscriptions
function isSubscriptionQuestion(message) {
    // Regex to check for phrases like "why subscribe", "subscription benefits", etc.
    const regex = /(\bpourquoi\b.*\b(s'abonner|s'abonne|subscribe)\b|\b(avantages?|bénéfices?)\b.*\b(s'abonnement|sub)\b|\b(c'est|c\'est)\b.*\b(un sub|abonné|abonnement)\b)/i;
    return regex.test(message);  // Uses .test() to check the message
}

// Function to ask OpenAI about chonch
async function askOpenAIAboutChonch(question, language) {
    additionalInfo = ${prompts.chonch};
    
    const prompt = buildPrompt({
        language,
        question,
        additionalInfo
    });

    const openaiResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
    });

    return openaiResponse.choices[0].message.content.trim();
}

// Function to check if the message contains "chonch"
function isChonchQuestion(message) {
    return message.toLowerCase().includes("chonch");
}

// Function to get the top 3 clips of the channel
async function getTopClips() {
    try {
        const response = await fetch(`https://api.twitch.tv/helix/clips?broadcaster_id=${BROADCASTER_ID}&first=3`, {
            headers: {
                'Authorization': `Bearer ${OAUTH_TOKEN}`,
                'Client-Id': CLIENT_ID,
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch clips: ${response.statusText}`);
        }

        const data = await response.json();
        const clips = data.data; // Array of clips

        if (clips.length === 0) {
            return "Aucun clip n'a été trouvé pour cette chaîne.";
        }

        // Extract unique game IDs from the clips
        const gameIds = [...new Set(clips.map(clip => clip.game_id))];

        // Fetch game names for the game IDs
        const gamesResponse = await fetch(`https://api.twitch.tv/helix/games?id=${gameIds.join('&id=')}`, {
            headers: {
                'Authorization': `Bearer ${OAUTH_TOKEN}`,
                'Client-Id': CLIENT_ID,
            },
        });

        if (!gamesResponse.ok) {
            throw new Error(`Failed to fetch game names: ${gamesResponse.statusText}`);
        }

        const gamesData = await gamesResponse.json();
        const gamesMap = gamesData.data.reduce((map, game) => {
            map[game.id] = game.name; // Map game_id to game_name
            return map;
        }, {});

        // Format the top 3 clips with game names
        return clips.map(clip => ({
            title: clip.title,
            game: gamesMap[clip.game_id] || "Jeu inconnu", // Use the game name or fallback
            url: clip.url,
            views: clip.view_count,
        }));
    } catch (error) {
        console.error("Error fetching top clips:", error);
        return "Impossible de récupérer les clips pour le moment.";
    }
}

// Function to ask OpenAI to format the top clips response
async function askOpenAIAboutClips(question, clipsInfo, language) {
    additionalInfo = `Voici les 3 clips les plus populaires de la chaîne Twitch :
    ${JSON.stringify(clipsInfo)}`;

    const prompt = buildPrompt({
        language,
        question,
        additionalInfo
    });

    const openaiResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
    });
    console.log(openaiResponse.choices[0].message.content.trim());
    return openaiResponse.choices[0].message.content.trim();
}

// Function to check if the message contains a question about top clips
function isTopClipsQuestion(message) {
    // Regex to check for phrases like "top clips", "meilleurs clips", "clips populaires", etc.
    const regex = /\b(donne moi|quel|top|meilleurs?|clips?|populaires?|le clip le plus|plus vues?|meilleur clip|clip le plus populaire)\b.*\b(clips?|vidéos?)?\b/i;
    
    return regex.test(message); // Uses .test() to check the message
}