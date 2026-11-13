require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory state for queue management and live UI updates
let queue = [];
let isProcessing = false;
let logs = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Format phone numbers to 2547XXXXXXXX / 2541XXXXXXXX
function formatPhone(raw) {
  let cleaned = raw.replace(/\D/g, '');
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    cleaned = '254' + cleaned.slice(1);
  } else if ((cleaned.startsWith('7') || cleaned.startsWith('1')) && cleaned.length === 9) {
    cleaned = '254' + cleaned;
  }
  return cleaned;
}

function addLog(phone, status, message) {
  const entry = {
    time: new Date().toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi' }),
    phone,
    status,
    message
  };
  logs.unshift(entry);
  if (logs.length > 100) logs.pop(); // Keep last 100 logs
}

// Background Worker: Processes 1 request every 5 seconds with 502/504 retry handling
async function processQueue() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;

  while (queue.length > 0) {
    const job = queue.shift();
    const orderRef = `ORDER_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const payload = {
      amount: Number(job.amount),
      currency: 'KES',
      reference: orderRef,
      customer: {
        email: job.email || 'customer@example.com',
        name: job.name || 'Customer',
        phone: job.phone
      },
      callback_url: process.env.CALLBACK_URL || 'https://yourshop.co.ke/webhooks/payza',
      metadata: {
        order_id: orderRef
      }
    };

    let retries = 0;
    const maxRetries = 3;
    let success = false;

    // Retry loop for handling gateway 502/504 errors
    while (retries <= maxRetries && !success) {
      try {
        const response = await axios.post('https://payzaapi.co.ke/api/v1/pay', payload, {
          headers: {
            'X-Public-Key': process.env.PAYZA_PUBLIC_KEY,
            'X-Secret-Key': process.env.PAYZA_SECRET_KEY,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        });

        addLog(job.phone, 'SUCCESS', `STK Sent (Ref: ${orderRef}) - ${JSON.stringify(response.data)}`);
        success = true;
      } catch (error) {
        const status = error.response ? error.response.status : null;
        
        // Handle Cloudflare 502 Bad Gateway or 504 Gateway Timeout
        if ((status === 502 || status === 504) && retries < maxRetries) {
          retries++;
          addLog(job.phone, 'RETRY', `Gateway ${status} received. Waiting 60s before retry ${retries}/${maxRetries}...`);
          await sleep(60000); // Respect Cloudflare retry_after window
          continue;
        }

        const errDetail = error.response ? JSON.stringify(error.response.data) : error.message;
        addLog(job.phone, 'FAILED', errDetail);
        break;
      }
    }

    // Wait 5 seconds before firing the next STK request if more items remain
    if (queue.length > 0) {
      await sleep(5000);
    }
  }

  isProcessing = false;
}

// Endpoint to enqueue phone numbers from the UI
app.post('/api/enqueue', (req, res) => {
  const { phones, amount, name, email } = req.body;

  if (!phones || !Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ error: 'Provide at least one phone number.' });
  }
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Provide a valid amount.' });
  }

  const validJobs = [];
  phones.forEach((rawPhone) => {
    const formatted = formatPhone(rawPhone.trim());
    if (/^254[17]\d{8}$/.test(formatted)) {
      validJobs.push({ phone: formatted, amount, name, email });
    } else if (rawPhone.trim() !== '') {
      addLog(rawPhone, 'SKIPPED', 'Invalid Kenyan mobile format');
    }
  });

  queue.push(...validJobs);
  processQueue(); 

  res.json({
    queued: validJobs.length,
    totalInQueue: queue.length
  });
});

// Endpoint for UI polling
app.get('/api/status', (req, res) => {
  res.json({
    isProcessing,
    remaining: queue.length,
    logs
  });
});

// Endpoint to clear queue if needed
app.post('/api/clear', (req, res) => {
  queue = [];
  res.json({ message: 'Queue cleared' });
});

// Payza Webhook Receiver
app.post('/webhooks/payza', (req, res) => {
  console.log('Webhook received:', req.body);
  const phone = req.body?.customer?.phone || 'WEBHOOK';
  addLog(phone, 'WEBHOOK', JSON.stringify(req.body));
  res.status(200).send('OK');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`STK Bot running on port ${PORT}`);
});
