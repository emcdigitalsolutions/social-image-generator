/**
 * plan-templates.js — helper per gestire template piano editoriale.
 *
 * Permette di:
 *  - serializzare un piano esistente in template (rimuovendo dati cliente-specific)
 *  - applicare un template a un nuovo cliente (sostituendo placeholder)
 */
'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./db');

// Settori → label leggibile (sync con questionnaire-config)
const SECTOR_LABELS = {
  onoranze_funebri: 'Onoranze Funebri',
  ristorazione: 'Ristorazione',
  abbigliamento: 'Abbigliamento',
  alimentari: 'Alimentari',
  estetica: 'Estetica / Benessere',
  studio_professionale: 'Studio Professionale',
  erboristeria: 'Erboristeria',
  artigianato: 'Artigianato',
  turismo: 'Turismo / Hospitality',
  edilizia: 'Edilizia / Impiantistica'
};

/**
 * Walk ricorsivo che applica una funzione di trasformazione a ogni stringa
 * dentro l'oggetto. Usato per replace placeholder.
 */
function transformStrings(obj, transformer) {
  if (typeof obj === 'string') return transformer(obj);
  if (Array.isArray(obj)) return obj.map(item => transformStrings(item, transformer));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = transformStrings(v, transformer);
    return out;
  }
  return obj;
}

/**
 * Sostituisce i placeholder {{key}} nelle stringhe del template con i valori
 * del cliente. Se un placeholder non ha valore, lo lascia invariato (per evitare
 * stringhe vuote inquietanti tipo "Visita "/"!").
 */
function substitutePlaceholders(planData, replacements) {
  return transformStrings(planData, (s) => {
    return s.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      const v = replacements[key];
      return (v != null && v !== '') ? String(v) : match;
    });
  });
}

/**
 * Costruisce il dict di replacements da un client row.
 */
function clientReplacements(client) {
  return {
    brand_name:   client.brand_name || client.display_name || '',
    display_name: client.display_name || '',
    location:     client.location || '',
    website:      client.website || '',
    tagline:      client.tagline || '',
    sector_label: SECTOR_LABELS[client.sector] || client.sector || ''
  };
}

/**
 * Serializza un piano esistente come template "pulito":
 *  - rimuove campi cliente-specific (id post, fb_post_id, ig_media_id, ecc.)
 *  - mantiene struttura categories + months + weeks + posts (con sub_topic, notes,
 *    media_type, day, time, category, template)
 *  - le caption sono lasciate vuote (verranno rigenerate dall'AI per il nuovo cliente)
 */
function planToTemplate(planData) {
  const cleanCategories = (planData.categories || []).map(c => ({
    code: c.code,
    name: c.name,
    frequency: c.frequency,
    description: c.description
  }));

  const cleanMonths = (planData.months || []).map(m => ({
    month_number: m.month_number,
    weeks: (m.weeks || []).map(w => ({
      week_number: w.week_number,
      posts: (w.posts || []).map(p => ({
        day: p.day,
        time: p.time,
        category: p.category,
        sub_topic: p.sub_topic,
        media_type: p.media_type,
        template: p.template,
        notes: p.notes
        // NB: niente caption, image_url, status, fb_post_id, ig_media_id, scheduled_*
      }))
    }))
  }));

  return {
    title: planData.title || '',  // verrà override in applicazione
    categories: cleanCategories,
    months: cleanMonths
  };
}

/**
 * Applica un template a un cliente: clona il plan_data, sostituisce placeholder,
 * INSERT in editorial_plans + crea i row in posts (con sub_topic + media_type +
 * categoria, ma senza caption/image — verranno generate dal bulk-generate AI).
 *
 * @returns {string} editorial_plan_id appena creato
 */
function applyTemplateToClient({ template, client, scheduledStartDate }) {
  const db = getDb();

  // Parse plan_data se è stringa
  const tplData = typeof template.plan_data === 'string'
    ? JSON.parse(template.plan_data)
    : template.plan_data;

  // Sostituisci placeholder
  const replacements = clientReplacements(client);
  const planData = substitutePlaceholders(tplData, replacements);
  planData.title = `Piano Editoriale — ${client.display_name || client.id}`;

  const planId = uuidv4();
  const monthsCount = (planData.months || []).length || template.months_count || 6;

  db.prepare(`
    INSERT INTO editorial_plans (id, client_id, title, status, plan_data, ai_raw)
    VALUES (?, ?, ?, 'draft', ?, ?)
  `).run(planId, client.id, planData.title, JSON.stringify(planData), JSON.stringify({ from_template: template.id }));

  // Crea row posts (solo metadata, niente caption/image)
  const insertPost = db.prepare(`
    INSERT INTO posts (id, client_id, editorial_plan_id, month_number, week_number,
                       category, sub_topic, template, media_type,
                       status, approval_status, scheduled_date, scheduled_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'pending', ?, ?)
  `);

  const startDate = scheduledStartDate ? new Date(scheduledStartDate) : null;
  const tx = db.transaction(() => {
    for (const m of planData.months || []) {
      for (const w of m.weeks || []) {
        for (const p of w.posts || []) {
          // Calcola scheduled_date approssimativa se passata startDate
          let schedDate = null;
          if (startDate) {
            // monthOffset (0-based) + weekOffset → settimana ISO
            const monthOffset = (m.month_number || 1) - 1;
            const weekOffset = (w.week_number || 1) - 1;
            const dayOffset = dayNameToOffset(p.day || 'lunedì');
            const d = new Date(startDate);
            d.setMonth(d.getMonth() + monthOffset);
            d.setDate(d.getDate() + weekOffset * 7 + dayOffset);
            schedDate = d.toISOString().slice(0, 10);
          }
          insertPost.run(
            uuidv4(), client.id, planId,
            m.month_number || 1, w.week_number || 1,
            p.category || null, p.sub_topic || '', p.template || null, p.media_type || 'single_image',
            schedDate, p.time || null
          );
        }
      }
    }
  });
  tx();

  return { plan_id: planId, months_count: monthsCount };
}

function dayNameToOffset(name) {
  const map = { 'lunedì': 0, 'lunedi': 0, 'martedì': 1, 'martedi': 1, 'mercoledì': 2, 'mercoledi': 2, 'giovedì': 3, 'giovedi': 3, 'venerdì': 4, 'venerdi': 4, 'sabato': 5, 'domenica': 6 };
  return map[String(name || '').toLowerCase().trim()] != null ? map[String(name || '').toLowerCase().trim()] : 0;
}

module.exports = {
  SECTOR_LABELS,
  planToTemplate,
  substitutePlaceholders,
  applyTemplateToClient,
  clientReplacements
};
