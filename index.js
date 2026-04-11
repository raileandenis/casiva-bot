require('dotenv').config();
const { Telegraf, session } = require('telegraf');
const { analyzeInvoice } = require('./invoice-analyzer');
const { logToSupabase } = require('./supabase-client');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.use(session({
  defaultSession: () => ({
    pendingInvoice: null,
    waitingFor: null,
    selectedProject: null
  })
}));

// Start command
bot.start((ctx) => {
  ctx.reply(
    '👋 Welcome to Casiva Bot!\n\n' +
    'Send me a photo of a Dekada invoice and I will log it to the CRM.\n\n' +
    'Commands:\n' +
    '/projects - list active projects\n' +
    '/help - show help'
  );
});

// List active projects
bot.command('projects', async (ctx) => {
  const { getActiveProjects } = require('./supabase-client');
  const projects = await getActiveProjects();
  if (!projects.length) return ctx.reply('No active projects found.');

  const list = projects.map(p =>
    `• ${p.project_code} — ${p.title} (${p.clients?.name})`
  ).join('\n');

  ctx.reply('📋 Active projects:\n\n' + list + '\n\nSend a photo to start logging an invoice.');
});

// Handle photos
bot.on('photo', async (ctx) => {
  try {
    await ctx.reply('📸 Got it! Analyzing invoice...');

    // Get highest quality photo
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);

    // Analyze with Claude Vision
    const result = await analyzeInvoice(fileLink.href);

    if (!result.success) {
      return ctx.reply('❌ Could not read invoice. Please try a clearer photo.');
    }

    // Store in session
    ctx.session.pendingInvoice = result.invoice;
    ctx.session.waitingFor = 'project';

    // Show what was found
    const inv = result.invoice;
    let summary = `✅ Invoice analyzed!\n\n`;
    summary += `📄 Order: #${inv.order_number}\n`;
    summary += `📅 Date: ${inv.date}\n`;
    summary += `🏢 Supplier: Dekada\n\n`;
    summary += `📦 Items found:\n`;

    inv.materials.forEach(m => {
      summary += `  • ${m.description}: ${m.amount} MDL\n`;
    });
    inv.services.forEach(s => {
      summary += `  • [SERVICE] ${s.description}: ${s.amount} MDL\n`;
    });

    summary += `\n💰 Total: ${inv.total} MDL\n\n`;
    summary += `Which project is this for?\nReply with project code (e.g. MT678-1) or type /projects to see the list.`;

    ctx.reply(summary);
  } catch (err) {
    console.error('Photo error:', err);
    ctx.reply('❌ Error processing photo. Please try again.');
  }
});

// Handle text replies (project code)
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();

  if (ctx.session.waitingFor === 'project' && ctx.session.pendingInvoice) {
    if (text.startsWith('/')) return; // ignore commands

    const { findProject } = require('./supabase-client');
    const project = await findProject(text.toUpperCase());

    if (!project) {
      return ctx.reply(`❌ Project "${text}" not found. Try again or use /projects to see active projects.`);
    }

    ctx.session.selectedProject = project;
    ctx.session.waitingFor = 'confirm';

    const inv = ctx.session.pendingInvoice;
    let msg = `📋 Project found: ${project.project_code} — ${project.title}\n`;
    msg += `Client: ${project.clients?.name}\n\n`;
    msg += `Ready to log:\n`;

    inv.materials.forEach(m => {
      msg += `  ✓ Material: ${m.description} — ${m.amount} MDL\n`;
    });
    inv.services.forEach(s => {
      msg += `  ✓ Service: ${s.description} — ${s.amount} MDL\n`;
    });

    msg += `\nReply YES to confirm or NO to cancel.`;
    ctx.reply(msg);
    return;
  }

  if (ctx.session.waitingFor === 'confirm') {
    if (text.toLowerCase() === 'yes') {
      try {
        await ctx.reply('💾 Logging to CRM...');
        const result = await logToSupabase(
          ctx.session.pendingInvoice,
          ctx.session.selectedProject
        );

        ctx.reply(
          `✅ Done! Logged ${result.count} cost entries to project ${ctx.session.selectedProject.project_code}\n` +
          `Total: ${result.total} MDL\n\n` +
          `View in CRM: https://casiva-app.vercel.app/projects/${ctx.session.selectedProject.id}`
        );

        // Reset session
        ctx.session.pendingInvoice = null;
        ctx.session.waitingFor = null;
        ctx.session.selectedProject = null;
      } catch (err) {
        console.error('Log error:', err);
        ctx.reply('❌ Error saving to CRM. Please try again.');
      }
    } else if (text.toLowerCase() === 'no') {
      ctx.session.pendingInvoice = null;
      ctx.session.waitingFor = null;
      ctx.session.selectedProject = null;
      ctx.reply('❌ Cancelled. Send another invoice photo when ready.');
    } else {
      ctx.reply('Please reply YES to confirm or NO to cancel.');
    }
    return;
  }
});

bot.help((ctx) => {
  ctx.reply(
    '📖 How to use Casiva Bot:\n\n' +
    '1. Send a photo of a Dekada invoice\n' +
    '2. Bot reads all items and amounts\n' +
    '3. Reply with project code (e.g. MT678-1)\n' +
    '4. Confirm with YES\n' +
    '5. Done! Cost entries appear in CRM\n\n' +
    'Commands:\n' +
    '/projects - list active projects\n' +
    '/start - restart bot'
  );
});

bot.launch();
console.log('🤖 Casiva Bot is running...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
