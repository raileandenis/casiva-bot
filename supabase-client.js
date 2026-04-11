const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function getActiveProjects() {
  const { data, error } = await supabase
    .from('projects')
    .select('id, project_code, title, status, clients(name)')
    .not('status', 'in', '("done","invoiced")')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function findProject(code) {
  const { data, error } = await supabase
    .from('projects')
    .select('id, project_code, title, client_id, clients(name)')
    .ilike('project_code', code)
    .single();

  if (error) return null;
  return data;
}

async function logToSupabase(invoice, project) {
  const dekadaId = await getDekadaId();
  const today = invoice.date || new Date().toISOString().split('T')[0];
  const receiptRef = invoice.order_number;

  const entries = [];

  // ONE entry for all materials combined
  if (invoice.materials.length > 0) {
    const materialsTotal = invoice.materials.reduce((sum, m) => sum + m.amount, 0);
    const materialTypes = [...new Set(invoice.materials.map(m => m.material_type))].join(', ');
    const itemDetails = invoice.materials.map(m =>
      `${m.description}: ${m.quantity} ${m.unit} × ${m.unit_price} = ${m.amount} MDL`
    ).join('\n');

    entries.push({
      project_id: project.id,
      supplier_id: dekadaId,
      category: 'material',
      description: `Dekada - ${materialTypes} (Order #${invoice.order_number})`,
      amount: Math.round(materialsTotal * 100) / 100,
      date: today,
      receipt_ref: receiptRef,
      notes: itemDetails,
      source: 'telegram'
    });
  }

  // ONE entry for all services combined
  if (invoice.services.length > 0) {
    const servicesTotal = invoice.services.reduce((sum, s) => sum + s.amount, 0);
    const itemDetails = invoice.services.map(s =>
      `${s.description}: ${s.quantity} ${s.unit} × ${s.unit_price} = ${s.amount} MDL`
    ).join('\n');

    entries.push({
      project_id: project.id,
      supplier_id: dekadaId,
      category: 'service',
      description: `Dekada - Services (Order #${invoice.order_number})`,
      amount: Math.round(servicesTotal * 100) / 100,
      date: today,
      receipt_ref: receiptRef,
      notes: itemDetails,
      source: 'telegram'
    });
  }

  const { error } = await supabase.from('cost_entries').insert(entries);
  if (error) throw error;

  const total = entries.reduce((sum, e) => sum + e.amount, 0);
  return { count: entries.length, total: Math.round(total * 100) / 100 };
}

// Find Dekada supplier ID to link cost entries
async function getDekadaId() {
  const { data } = await supabase
    .from('suppliers')
    .select('id')
    .ilike('name', '%dekada%')
    .single();
  return data?.id || null;
}

module.exports = { getActiveProjects, findProject, logToSupabase, getDekadaId };
