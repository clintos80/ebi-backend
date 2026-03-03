require("dotenv").config();
const express = require("express");
const OpenAI = require("openai");
const bodyParser = require("body-parser");

const app = express();
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(bodyParser.urlencoded({ extended: false }));

const { google } = require("googleapis");
const path = require("path");

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, "google-credentials.json"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

const SPREADSHEET_ID = "1OA3gGUzHlFoIyGRUvk-_q7qfepR4lKJcLqS8PNX0TUA";

// When call first connects
app.post("/voice", (req, res) => {
  const twiml = `
    <Response>
      <Say>Hello, this is Ebi, your AI receptionist. How can I help you today?</Say>
      <Gather input="speech" action="/process" method="POST" timeout="5">
      </Gather>
    </Response>
  `;
  res.type("text/xml");
  res.send(twiml);
});

// Process caller speech
app.post("/process", async (req, res) => {
  const userSpeech = req.body.SpeechResult;
  const callerNumber = req.body.From;
  const timestamp = new Date().toISOString();

  let aiReply = "Sorry, I didn't catch that. Could you repeat?";

  if (userSpeech) {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
        You are Ebi, an intelligent Australian AI receptionist for local service businesses.

        Your job is to:
        - Greet callers professionally
        - Understand their request
        - Collect their name, phone number, and service needed
        - Ask clarifying questions if needed
        - Be concise, friendly, and confident
        - Speak naturally, like a real human receptionist
        - Keep responses under 3 sentences

        If booking intent is clear, guide them toward scheduling.
        Never say you are an AI unless directly asked.
        `,
        },
      ],
    });

    aiReply = completion.choices[0].message.content;

    // Log to Google Sheets
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: "A:D",
        valueInputOption: "RAW",
        requestBody: {
          values: [[timestamp, "", callerNumber, userSpeech]],
        },
      });
    } catch (error) {
      console.error("Error logging to sheet:", error);
    }
  }

  const twiml = `
    <Response>
      <Say>${aiReply}</Say>
      <Gather input="speech" action="/process" method="POST" timeout="5">
      </Gather>
    </Response>
  `;

  res.type("text/xml");
  res.send(twiml);
});

app.listen(3000, () => {
  console.log("Server listening at http://localhost:3000");
});