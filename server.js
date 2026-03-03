require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const path = require("path");

const app = express();

/* ==========================
   Middleware
========================== */

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/* ==========================
   Health Check
========================== */

app.get("/", (req, res) => {
  res.send("Ebi backend is running");
});

/* ==========================
   OpenAI Setup
========================== */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ==========================
   Google Sheets Setup
========================== */

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, "google-credentials.json"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({
  version: "v4",
  auth,
});

const SPREADSHEET_ID = "1OA3gGUzHlFoIyGRUvk-_q7qfepR4lKJcLqS8PNX0TUA";

/* ==========================
   AI Helper Function
========================== */

async function generateAIReply(userInput) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are Ebi, an intelligent Australian AI receptionist for local service businesses.

Your job is to:
- Greet callers professionally
- Understand their request
- Collect their name, phone number, and service needed
- Ask clarifying questions if needed
- Be concise, friendly, and confident
- Keep responses under 3 sentences
- Never say you are an AI unless directly asked.`,
      },
      {
        role: "user",
        content: userInput,
      },
    ],
  });

  return completion.choices[0].message.content;
}

/* ==========================
   VOICE ROUTES
========================== */

// Initial greeting
app.post("/voice", (req, res) => {
  const twiml = `
<Response>
  <Say>Hello, this is Ebi, your AI receptionist. How can I help you today?</Say>
  <Gather input="speech" action="/process" method="POST" timeout="5" />
</Response>
  `;

  res.type("text/xml");
  res.send(twiml);
});

// Process voice speech
app.post("/process", async (req, res) => {
  try {
    const userSpeech = req.body.SpeechResult;
    const callerNumber = req.body.From;
    const timestamp = new Date().toISOString();

    let aiReply = "Sorry, I didn't catch that. Could you repeat?";

    if (userSpeech) {
      aiReply = await generateAIReply(userSpeech);

      // Log to Google Sheets
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: "A:D",
        valueInputOption: "RAW",
        requestBody: {
          values: [[timestamp, "VOICE", callerNumber, userSpeech]],
        },
      });
    }

    const twiml = `
<Response>
  <Say>${aiReply}</Say>
  <Gather input="speech" action="/process" method="POST" timeout="5" />
</Response>
    `;

    res.type("text/xml");
    res.send(twiml);
  } catch (error) {
    console.error("Voice processing error:", error.message);

    res.type("text/xml");
    res.send(`
<Response>
  <Say>Sorry, something went wrong. Please try again later.</Say>
</Response>
    `);
  }
});

/* ==========================
   SMS ROUTE
========================== */

app.post("/sms", async (req, res) => {
  try {
    const userMessage = req.body.Body;
    const senderNumber = req.body.From;
    const timestamp = new Date().toISOString();

    let aiReply = "Sorry, I didn't understand that.";

    if (userMessage) {
      aiReply = await generateAIReply(userMessage);

      // Log to Google Sheets
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: "A:D",
        valueInputOption: "RAW",
        requestBody: {
          values: [[timestamp, "SMS", senderNumber, userMessage]],
        },
      });
    }

    const twiml = `
<Response>
  <Message>${aiReply}</Message>
</Response>
    `;

    res.type("text/xml");
    res.send(twiml);
  } catch (error) {
    console.error("SMS processing error:", error.message);

    res.type("text/xml");
    res.send(`
<Response>
  <Message>Sorry, something went wrong. Please try again later.</Message>
</Response>
    `);
  }
});

/* ==========================
   START SERVER (Render Safe)
========================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});