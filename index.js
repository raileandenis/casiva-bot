require('dotenv').config();
const { Telegraf, session, Markup } = require('telegraf');
const { analyzeInvoice } = require('./invoice-analyzer');
const { logDekadaToProject, createInboxEntry, getActiveProjects, findProject } = require('./supabase-client');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Command menu shown when user types /
bot.telegram.setMyCommands([
  { command: 'start', description: 'Start the bot' },
  { command: 'projects', description: 'List active projects' },
  { command: 'inbox', description: 'Check pending inbox items' },
  { command: 'help', description: 'How to use this bot' },
]);

bot.use(session({
  defaultSession: () => ({
    pendingInvoice: null,
    waitingFor: null,
    selectedProject: null
  })
}));

bot.start((ctx) => {
  ctx.reply(
    '👋 Welcome to Casiva Bot!\n\n' +
    'Send me a photo of an invoice:\n' +
    '• Dekada → logged directly to project\n' +
    '• Accemob/Other → goes to inbox for review\n\n' +
    'Use /projects to see active projects\n' +
    'Use /inbox to check pending items'
  );
});

bot.command('projects', async (ctx) => {
  const projects = await getActiveProjects();
  if (!projects.length) return ctx.reply('No active projects.');
  const list = projects.map(p =>
    `• ${p.project_code} — ${p.title} (${p.clients?.name})`
  ).join('\n');
  ctx.reply('📋 Active projects:\n\n' + list);
});

bot.command('inbox', async (ctx) => {
  const { getPendingInboxCount } = require('./supabase-client');
  const count = await getPendingInboxCount();
  if (count === 0) {
    ctx.reply('✅ Inbox is empty! No pending items.');
  } else {
    ctx.reply(
      `📬 You have ${count} pending invoice(s) to review.\n\n` +
      `Open CRM to review: https://casiva-app.vercel.app/inbox`
    );
  }
});

bot.help((ctx) => {
  ctx.reply(
    '📖 How to use:\n\n' +
    '1. Send a photo of any invoice\n' +
    '2. Bot detects supplier automatically\n\n' +
    'DEKADA invoices:\n' +
    '→ Select project from menu\n' +
    '→ Confirm → logged immediately\n\n' +
    'ACCEMOB/OTHER invoices:\n' +
    '→ Items matched to your inventory\n' +
    '→ Sent to inbox for review\n' +
    '→ Review at casiva-app.vercel.app/inbox\n\n' +
    '/projects - list active projects\n' +
    '/inbox - check pending items'
  );
});

// Handle photos
bot.on('photo', async (ctx) => {
  try {
    await ctx.reply('📸 Analyzing invoice...');
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const result = await analyzeInvoice(fileLink.href);

    if (!result.success) {
      return ctx.reply('❌ Could not read invoice. Try a clearer photo.');
    }

    const inv = result.invoice;
    ctx.session.pendingInvoice = inv;

    // Show what was found
    let summary = `✅ Invoice read!\n\n`;
    summary += `🏢 Supplier: ${inv.supplier}\n`;
    summary += `📄 Invoice #${inv.invoice_number}\n`;
    summary += `📅 Date: ${inv.date}\n`;
    summary += `💰 Total: ${inv.total} MDL\n`;
    summary += `📦 Items: ${inv.items?.length || (inv.materials?.length || 0) + (inv.services?.length || 0)}\n\n`;

    if (inv.supplier_type === 'dekada') {
      // Dekada flow - show project selection buttons
      const projects = await getActiveProjects();
      ctx.session.waitingFor = 'project_dekada';

      const buttons = projects.map(p =>
        Markup.button.callback(
          `${p.project_code} — ${p.title}`,
          `project_${p.id}`
        )
      );

      // Split into rows of 1 button each
      const keyboard = Markup.inlineKeyboard(
        buttons.map(b => [b])
      );

      await ctx.reply(summary + 'Select project for this Dekada invoice:', keyboard);

    } else {
      // Accemob/Other flow - go to inbox
      summary += `Items will be matched to your inventory.\n`;
      summary += `Review at: casiva-app.vercel.app/inbox`;

      const userName = ctx.from?.first_name || ctx.from?.username || 'Unknown';
      await createInboxEntry(inv, userName);
      await ctx.reply(summary);
    }

  } catch (err) {
    console.error('Photo error:', err);
    ctx.reply('❌ Error processing photo. Please try again.');
  }
});

// Handle project selection buttons (Dekada)
bot.action(/project_(.+)/, async (ctx) => {
  const projectId = ctx.match[1];
  try {
    const { findProjectById } = require('./supabase-client');
    const project = await findProjectById(projectId);
    if (!project) return ctx.answerCbQuery('Project not found');

    ctx.session.selectedProject = project;
    ctx.session.waitingFor = 'confirm_dekada';

    const inv = ctx.session.pendingInvoice;
    let msg = `📋 Project: ${project.project_code} — ${project.title}\n`;
    msg += `Client: ${project.clients?.name}\n\n`;

    // Show breakdown
    const matTotal = inv.materials?.reduce((s, m) => s + m.amount, 0) || 0;
    const svcTotal = inv.services?.reduce((s, s2) => s + s2.amount, 0) || 0;

    if (matTotal > 0) msg += `📦 Materials: ${matTotal.toFixed(2)} MDL\n`;
    if (svcTotal > 0) msg += `🔧 Services: ${svcTotal.toFixed(2)} MDL\n`;
    msg += `💰 Total: ${inv.total} MDL\n\n`;

    await ctx.editMessageText(msg + 'Confirm logging to CRM?',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, log it', 'confirm_yes')],
        [Markup.button.callback('❌ Cancel', 'confirm_no')]
      ])
    );
    ctx.answerCbQuery();
  } catch (err) {
    console.error(err);
    ctx.answerCbQuery('Error');
  }
});

// Confirm Dekada logging
bot.action('confirm_yes', async (ctx) => {
  try {
    const inv = ctx.session.pendingInvoice;
    const project = ctx.session.selectedProject;
    const result = await logDekadaToProject(inv, project);

    await ctx.editMessageText(
      `✅ Logged to ${project.project_code}!\n` +
      `${result.count} entries, total ${result.total} MDL\n\n` +
      `View: https://casiva-app.vercel.app/projects/${project.id}`
    );

    ctx.session.pendingInvoice = null;
    ctx.session.waitingFor = null;
    ctx.session.selectedProject = null;
    ctx.answerCbQuery('Done!');
  } catch (err) {
    console.error(err);
    ctx.answerCbQuery('Error saving');
  }
});

bot.action('confirm_no', async (ctx) => {
  ctx.session.pendingInvoice = null;
  ctx.session.waitingFor = null;
  ctx.session.selectedProject = null;
  await ctx.editMessageText('❌ Cancelled.');
  ctx.answerCbQuery();
});

bot.launch();
console.log('🤖 Casiva Bot running...');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
