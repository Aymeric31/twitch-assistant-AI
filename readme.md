# Twitch Chat Bot with WebSockets and OpenAI

This project is a Twitch chat bot that uses the Twitch EventSub WebSocket API to interact with the chat in real-time, OpenAI to generate smart responses, and manages OAuth authentication, including automatic token refreshing.

## 🚀 Features

- 🔌 WebSocket connection with Twitch EventSub
- 💬 Automatic chat responses using OpenAI GPT-4o
- 🔄 Automatic OAuth token refreshing
- 📅 Fetching and displaying the Twitch stream schedule
- 📱 Responding to questions about the channel's social media

## 🛠️ Prerequisites

- Node.js (v18 or higher recommended)
- A Twitch developer account
- An OpenAI API key

## 📁 Configuration

Create a `.env` file at the root of the project with the following variables:

```env
TWITCH_ACCESS_TOKEN=YourOAuthToken
TWITCH_REFRESH_TOKEN=YourRefreshToken
TWITCH_CLIENT_ID=YourClientID
TWITCH_CLIENT_SECRET=YourClientSecret
TWITCH_BROADCASTER_ID=YourBroadcasterID
BOT_USER_ID=YourBotUserID
OPENAI_API_KEY=YourOpenAIKey
INSTAGRAM_URL=YourInstagramURL
YOUTUBE_URL=YourYouTubeURL
VOD_URL=YourVODURL
DISCORD_URL=YourDiscordURL
X_URL=YourXURL
TIKTOK_URL=YourTiktokURL
```

## 🏃‍♂️ Running the Bot

```bash
npm install
node chatbot.js
```

## ⚙️ How It Works

### 1. OAuth Token Validation and Refreshing

The bot checks the validity of the OAuth token on every startup and automatically refreshes it if needed.

### 2. WebSocket Connection

The bot connects to the Twitch EventSub WebSocket API to receive real-time events.

### 3. Chat Message Handling

- **Command !brigadier**: The bot sends the question to OpenAI and returns the response in the chat.
- **Stream Schedule Questions**: The bot fetches the Twitch schedule via the API and generates an appropriate response.
- **Social Media Questions**: The bot provides links to the channel's social platforms.

## 📚 Command Examples

```
!brigadier When is the next stream?
!brigadier What game will be played in the next live stream?
!brigadier Where can I watch the VODs?
```

## 📝 Note

This bot is designed for your Twitch channel.

## 📄 License

This project is licensed under the MIT License.
