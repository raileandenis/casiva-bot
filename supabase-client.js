const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function getActiveProjects() {
  const { data } = await supabase
    .from('projects')
    .select('id, project_code, title, status, clients(name)')
    .not('status', 'in', '("done","invoiced")')
    .order('created_at', { ascending: false });
  return data || [];
}

async function findProject(code) {
  const { data } = await supabase
    .from('projects')
    .select('id, project_code, title, client_id, clients(name)')
    .ilike('project_code', code)
    .single();
  return data;
}

async function findProjectById(id) {
  const { data } = await supabase
    .from('projects')
    .select('id, project_code, title, client_id, clients(name)')
    .eq('id', id)
    .single();
  return data;
}

async function getDekadaId() {
  const { data } = await supabase
    .from('suppliers')
    .select('id')
    .ilike('name', '%dekada%')
    .single();
  return data?.id || null;
}

async function getPendingInboxCount() {
  const { count } = await supabase
    .from('inbox_items')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');
  return count || 0;
}

// Redistribute all payments across invoices oldest-first and update supplier debt.
// Mirrors the same logic as recalculateSupplierDebt in useSuppliers.ts.
async function recalculateSupplierDebt(supplierId) {
  const { data: invoices } = await supabase
    .from('supplier_invoices')
    .select('id, amount')
    .eq('supplier_id', supplierId)
    .order('date', { ascending: true });

  const { data: payments } = await supabase
    .from('supplier_payments')
    .select('id, amount')
    .eq('supplier_id', supplierId)
    .order('date', { ascending: true });

  const totalPayments = (payments || []).reduce((s, p) => s + (p.amount || 0), 0);

  if (!invoices || invoices.length === 0) {
    await supabase
      .from('suppliers')
      .update({ credit_balance: totalPayments, current_debt: 0 })
      .eq('id', supplierId);
    return;
  }

  // Reset all invoices to unpaid
  await supabase
    .from('supplier_invoices')
    .update({ amount_paid: 0, status: 'unpaid' })
    .eq('supplier_id', supplierId);

  // Distribute payment pool oldest-first
  let paymentPool = totalPayments;
  const updates = [];
  for (const inv of invoices) {
    if (paymentPool <= 0) {
      updates.push({ id: inv.id, amount_paid: 0, status: 'unpaid' });
    } else if (paymentPool >= inv.amount) {
      updates.push({ id: inv.id, amount_paid: inv.amount, status: 'paid' });
      paymentPool -= inv.amount;
    } else {
      updates.push({ id: inv.id, amount_paid: paymentPool, status: 'partial' });
      paymentPool = 0;
    }
  }

  await Promise.all(
    updates.map((u) =>
      supabase
        .from('supplier_invoices')
        .update({ amount_paid: u.amount_paid, status: u.status })
        .eq('id', u.id)
    )
  );

  const creditBalance = paymentPool;
  await supabase
    .from('suppliers')
    .update({ credit_balance: creditBalance, current_debt: 0 })
    .eq('id', supplierId);
}

// Option B: create supplier_invoice FIRST, then cost_entries linked to it.
// This prevents double-counting: cost_entries = actual spend, invoice = debt record.
async function logDekadaToProject(invoice, project, isDebt = false) {
  const dekadaId = await getDekadaId();
  const today = invoice.date || new Date().toISOString().split('T')[0];
  const receiptRef = invoice.invoice_number;
  const totalAmount = invoice.total ||
    (invoice.materials?.reduce((s, m) => s + m.amount, 0) || 0) +
    (invoice.services?.reduce((s, sv) => s + sv.amount, 0) || 0);

  let supplierInvoiceId = null;

  // STEP 1: Create supplier invoice FIRST if recording as debt
  if (isDebt && dekadaId) {
    const { data: inv, error: invError } = await supabase
      .from('supplier_invoices')
      .insert({
        supplier_id: dekadaId,
        invoice_number: receiptRef,
        amount: Math.round(totalAmount * 100) / 100,
        date: today,
        description: `Dekada Order #${receiptRef}`,
        project_id: project.id,
        status: 'unpaid',
        source: 'telegram'
      })
      .select()
      .single();

    if (invError) throw invError;
    supplierInvoiceId = inv.id;

    // Recalculate debt after creating the invoice
    await recalculateSupplierDebt(dekadaId);
  }

  // STEP 2: Create cost entries linked to supplier invoice
  const entries = [];

  if (invoice.materials?.length > 0) {
    const matTotal = invoice.materials.reduce((s, m) => s + m.amount, 0);
    const types = [...new Set(invoice.materials.map(m => m.material_type))].filter(Boolean).join(', ');
    const details = invoice.materials.map(m =>
      `${m.description}: ${m.quantity} ${m.unit} × ${m.unit_price} = ${m.amount} MDL`
    ).join('\n');

    entries.push({
      project_id: project.id,
      supplier_id: dekadaId,
      supplier_invoice_id: supplierInvoiceId,
      category: 'material',
      description: `Dekada - ${types || 'Materials'} (Order #${receiptRef})`,
      amount: Math.round(matTotal * 100) / 100,
      date: today,
      receipt_ref: receiptRef,
      notes: details,
      source: 'telegram'
    });
  }

  if (invoice.services?.length > 0) {
    const svcTotal = invoice.services.reduce((s, sv) => s + sv.amount, 0);
    const details = invoice.services.map(s =>
      `${s.description}: ${s.quantity} ${s.unit} × ${s.unit_price} = ${s.amount} MDL`
    ).join('\n');

    entries.push({
      project_id: project.id,
      supplier_id: dekadaId,
      supplier_invoice_id: supplierInvoiceId,
      category: 'service',
      description: `Dekada - Services (Order #${receiptRef})`,
      amount: Math.round(svcTotal * 100) / 100,
      date: today,
      receipt_ref: receiptRef,
      notes: details,
      source: 'telegram'
    });
  }

  const { error } = await supabase.from('cost_entries').insert(entries);
  if (error) throw error;

  const total = entries.reduce((s, e) => s + e.amount, 0);
  return { count: entries.length, total: Math.round(total * 100) / 100 };
}

async function createInboxEntry(invoice, createdBy) {
  // 1. Insert inbox_item
  const { data: inboxItem, error } = await supabase
    .from('inbox_items')
    .insert({
      supplier_name: invoice.supplier,
      invoice_number: invoice.invoice_number,
      invoice_date: invoice.date,
      invoice_total: invoice.total,
      source: 'telegram',
      status: 'pending',
      created_by: createdBy,
      raw_data: invoice
    })
    .select()
    .single();

  if (error) throw error;

  // 2. For each item, try to match by article number
  const lineItems = [];
  for (const item of (invoice.items || [])) {
    let matchedItem = null;
    let matchConfidence = 'none';

    if (item.article_number) {
      // Try exact article number match
      const { data: exact } = await supabase
        .from('inventory_items')
        .select('id, name, article_number, current_stock, inventory_units(abbreviation)')
        .eq('article_number', item.article_number)
        .single();

      if (exact) {
        matchedItem = exact;
        matchConfidence = 'exact';
      } else {
        // Try partial name match
        const { data: partial } = await supabase
          .from('inventory_items')
          .select('id, name, article_number, current_stock, inventory_units(abbreviation)')
          .ilike('name', `%${item.name.substring(0, 15)}%`)
          .single();

        if (partial) {
          matchedItem = partial;
          matchConfidence = 'partial';
        }
      }
    }

    lineItems.push({
      inbox_id: inboxItem.id,
      action: matchedItem ? 'add_stock' : 'create_item',
      inventory_item_id: matchedItem?.id || null,
      suggested_name: item.name,
      suggested_article: item.article_number,
      suggested_unit: item.unit,
      quantity: item.quantity,
      unit_price: item.unit_price,
      amount: item.amount,
      status: 'pending',
      match_confidence: matchConfidence,
      notes: matchedItem ? `Matched to: ${matchedItem.name}` : 'No match found - will create new item'
    });
  }

  // 3. Insert all line items
  if (lineItems.length > 0) {
    const { error: lineError } = await supabase
      .from('inbox_line_items')
      .insert(lineItems);
    if (lineError) throw lineError;
  }

  return inboxItem;
}

module.exports = {
  getActiveProjects,
  findProject,
  findProjectById,
  getDekadaId,
  getPendingInboxCount,
  logDekadaToProject,
  createInboxEntry,
  recalculateSupplierDebt
};
