const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function analyzeInvoice(imageUrl) {
  try {
    // Download image and convert to base64
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const base64 = Buffer.from(response.data).toString('base64');
    const rawType = response.headers['content-type'] || '';
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const mediaType = allowedTypes.find(t => rawType.includes(t)) || 'image/jpeg';

    const prompt = `You are analyzing a Dekada Partners invoice (in Russian/Romanian).

Extract ALL line items and return ONLY valid JSON, no other text.

Rules:
- "II SERVICII" category = service items
- All other categories (PAL, MDF, HDF, ABS, HPL, COMPACT etc.) = material items
- Order number: extract digits only from "Comanda Nr.XXXXXXXXXX" (last meaningful digits, skip leading zeros)
- Date: from "din DD.MM.YYYY"
- For materials: group by material type in description (PAL / MDF / HDF / ABS / HPL / Compact HPL)
- For services: keep each service as separate item (Gaurire, Taiere, Incleiere ABS, Servicii Paz, Servicii Raza, Frezare etc.)
- Amount = the "Сумма/Suma" column value (final price including VAT)

Return this exact JSON:
{
  "success": true,
  "order_number": "5860",
  "date": "2026-03-24",
  "supplier": "Dekada",
  "total": 6403.09,
  "materials": [
    {
      "description": "MDF AGT - Matt Light Grey 18x2800x1220",
      "category": "material",
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
      "category": "service",
      "quantity": 31,
      "unit": "buc",
      "unit_price": 20,
      "amount": 620
    }
  ]
}`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64
            }
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
    console.error('Analysis error:', err);
    return { success: false, error: err.message };
  }
}

module.exports = { analyzeInvoice };
