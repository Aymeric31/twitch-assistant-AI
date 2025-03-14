import WebSocket from 'ws';
import fetch from 'node-fetch';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import * as fs from 'fs';

dotenv.config();

let OAUTH_TOKEN = process.env.TWITCH_ACCESS_TOKEN;
let REFRESH_TOKEN = process.env.TWITCH_REFRESH_TOKEN; 
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;

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

const PROMPT_PROFILE = process.env.PROMPT_PROFILE;
const PROMPT_NEGATIVE = process.env.PROMPT_NEGATIVE;

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

let websocketSessionId;

// Start the bot
(async () => {
    await validateToken(); // Validate the OAuth token
    startWebSocketConnection(); // Start the WebSocket connection
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
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
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
            .replace(/TWITCH_ACCESS_TOKEN=.*/, `TWITCH_ACCESS_TOKEN=${OAUTH_TOKEN}`)
            .replace(/TWITCH_REFRESH_TOKEN=.*/, `TWITCH_REFRESH_TOKEN=${REFRESH_TOKEN}`);
        fs.writeFileSync('.env', envContent);
        console.log('.env updated');
    } catch (error) {
        console.error('Error refreshing the token:', error.message);
        process.exit(1); // Stop the bot if unable to refresh
    }
}

// Start the WebSocket connection
function startWebSocketConnection() {
    const ws = new WebSocket(EVENTSUB_WEBSOCKET_URL);

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
        // Essayer de se reconnecter après un délai
        setTimeout(() => {
            console.log('Attempting to reconnect...');
            startWebSocketConnection();  // Reconnexion automatique
        }, 5000); // Attendre 5 secondes avant de tenter une reconnexion
    });

    // Ajouter un gestionnaire pour les pongs
    ws.on('pong', () => {
        console.log('Pong received.');
    });
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
            ws.close(); // Fermer la connexion actuelle
            startWebSocketConnection(reconnectUrl); // Reconnecter à l'URL fournie
            break;
        
        case 'keepalive':
            console.log('Keepalive received, connection is healthy.');
            break;

        case 'notification':
            if (message.metadata.subscription_type === 'channel.chat.message') {
                const chatMessage = message.payload.event.message.text;
                const sender = message.payload.event.chatter_user_login;

                if (chatMessage.startsWith('!brigadier')) {
                    const question = chatMessage.replace('!brigadier', '').trim();
                    handleBotCommand(question, sender);
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

// Send a message to the chat
async function sendChatMessage(message) {
    const response = await fetch('https://api.twitch.tv/helix/chat/messages', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OAUTH_TOKEN}`,
            'Client-Id': CLIENT_ID,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            broadcaster_id: BROADCASTER_ID,
            sender_id: BROADCASTER_ID, // The ID of the user sending the message
            message: message,
        }),
    });

    if (!response.ok) {
        console.error('Error sending the message:', await response.text());
    } else {
        console.log('Message sent:', message);
    }
}

async function handleBotCommand(question, sender) {
    if (isStreamQuestion(question)) {
        const schedule = await getTwitchSchedule();
        const response = await askOpenAIAboutSchedule(question, schedule);
        sendChatMessage(response);
    } else if (isSocialMediaQuestion(question)) {
        const response = await askOpenAIAboutSocials(question);
        sendChatMessage(response);
    } else if (isSubscriptionQuestion(question)) {
        const response = await askOpenAIAboutSubscription(question);
        sendChatMessage(response);
    } else {
        const response = await getOpenAIResponse(question);
        sendChatMessage(response);
    }
}

// Function to get a response from OpenAI
async function getOpenAIResponse(question) {
    try {
        const prompt = `${PROMPT_PROFILE}
        ${PROMPT_NEGATIVE}
        Voici la question du viewer: 
        ${question}`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
        });

        return response.choices[0].message.content;
    } catch (error) {
        console.error('Error when asking OpenAI:', error);
        return 'Désolé, je n\'ai pas été formé pour répondre à cette question';
    }
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

async function askOpenAIAboutSchedule(question, schedule) {
    const prompt = `${PROMPT_PROFILE}
    Voici les horaires de streaming, tu dois convertir les heures en GMT+1:
    ${JSON.stringify(schedule)}
    Réponds à cette question à propos du planning en te basant sur ces informations:
    ${question}`;

    const openaiResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
    });

    return openaiResponse.choices[0].message.content.trim();
}

// Check if a message contains a question about the schedule or stream
function isStreamQuestion(message) {
    const keywords = ['prochain stream', 'quand', 'heure', 'jeu', 'planning', 'stream', 'à quelle heure'];
    return keywords.some(keyword => message.toLowerCase().includes(keyword));
}

async function askOpenAIAboutSocials(question) {
    const prompt = `${PROMPT_PROFILE}
    Voici les liens vers les réseaux sociaux de la chaine:
    Instagram: ${INSTAGRAM_URL}
    YouTube: ${YOUTUBE_URL}
    VOD: ${VOD_URL}
    Tiktok: ${TIKTOK_URL}
    Discord: ${DISCORD_URL}
    X et twitter: ${X_URL}
    La question que l'on te pose est la suivante:
    ${question}`;

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

// Fonction pour interroger OpenAI à propos des abonnements
async function askOpenAIAboutSubscription(question) {
    const prompt = `${PROMPT_PROFILE}  
    Voici la question à propos de l'abonnement :  
    ${question}

    Essaie de convaincre en quelques mots pourquoi s'abonner à la chaîne. Mentionne les avantages suivants sans en rajouter ni faire de supposition :
    - De nouveaux emojis exclusifs.
    - Moins de publicités pendant les streams.
    - Un soutien direct à la chaîne et au créateur de contenu.

    Sois persuasif et donne une réponse convaincante !`;

    const openaiResponse = await openai.chat.completions.create({
        model: 'gpt-4-mini', // Ou un autre modèle si nécessaire
        messages: [{ role: 'user', content: prompt }],
    });

    return openaiResponse.choices[0].message.content.trim();
}

// Fonction pour vérifier si le message contient une question sur l'abonnement
function isSubscriptionQuestion(message) {
    // Regex pour vérifier des phrases comme "pourquoi s'abonner", "bénéfices du sub", etc.
    const regex = /(\bpourquoi\b.*\b(s'abonner|s'abonne|subscribe)\b|\b(avantages?|bénéfices?)\b.*\b(s'abonnement|sub)\b|\b(c'est|c\'est)\b.*\b(un sub|abonné|abonnement)\b)/i;
    return regex.test(message);  // Utilise .test() pour tester le message
}