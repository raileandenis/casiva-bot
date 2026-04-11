const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function analyzeInvoice(imageUrl) {
  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const base64 = Buffer.from(response.data).toString('base64');
    const mediaType = 'image/jpeg';

    const prompt = `Analyze this invoice image and return ONLY valid JSON, no other text.

SUPPLIER DETECTION:
- If you see "Dekada" or "Unicompro" → supplier_type: "dekada"
- If you see "Accemob" → supplier_type: "accemob"
- Otherwise → supplier_type: "other"

For DEKADA invoices:
- invoice_number: digits only from "Comanda Nr.XXXXXXXXXX" (skip leading zeros)
- date: from "din DD.MM.YYYY" → format as YYYY-MM-DD
- Split items into materials and services:
  - "II SERVICII" category = services
  - Everything else = materials, detect material_type (PAL/MDF/HDF/ABS/HPL/Compact)

For ACCEMOB/OTHER invoices:
- invoice_number: digits from "Factura N PHн-XXXXXXXX" or similar
- date: from "Din DD Month YYYY" → format as YYYY-MM-DD
- All items go into "items" array with article numbers

Return this JSON format:

For Dekada:
{
  "success": true,
  "supplier": "Dekada",
  "supplier_type": "dekada",
  "invoice_number": "5860",
  "date": "2026-03-24",
  "total": 6403.09,
  "materials": [
    {
      "description": "MDF AGT Matt Light Grey 18x2800x1220",
      "material_type": "MDF",
      "quantity": 3.416,
      "unit": "m2",
      "unit_price": 396,
      "amount": 1352.74
    }
  ],
  "services": [
    {
      "description": "Gaurire",
      "quantity": 31,
      "unit": "buc",
      "unit_price": 20,
      "amount": 620
    }
  ]
}

For Accemob/Other:
{
  "success": true,
  "supplier": "Accemob Grup SRL",
  "supplier_type": "accemob",
  "invoice_number": "54996",
  "date": "2025-08-19",
  "total": 9023.30,
  "items": [
    {
      "article_number": "24001",
      "name": "Picior bucatarie H95-130 din 3 parti Negru",
      "unit": "buc",
      "quantity": 35,
      "unit_price": 3.30,
      "amount": 115.50
    },
    {
      "article_number": "311.04.205",
      "name": "METALLA 110 SM CLIP Balama aplicata cu amortizare",
      "unit": "buc",
      "quantity": 100,
      "unit_price": 10.10,
      "amount": 1010.00
    }
  ]
}

Extract ALL line items. Article numbers are in the first column (№).
If article number cell is empty, use null.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          },
          { type: 'text', text: prompt }
        ]
      }]
    });

    const text = message.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();

    let invoice;
    try {
      invoice = JSON.parse(clean);
    } catch (parseErr) {
      console.error('JSON parse failed. Raw Claude response:\n', text);
      throw new Error(`Failed to parse Claude response: ${parseErr.message}`);
    }

    return { success: true, invoice };

  } catch (err) {
    console.error('Analysis error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { analyzeInvoice };
