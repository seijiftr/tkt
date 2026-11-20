export function initFaq(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS faq_entries (
    id TEXT PRIMARY KEY, guild TEXT NOT NULL, question TEXT NOT NULL,
    answer TEXT NOT NULL, locale TEXT NOT NULL, published INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS faq_lookup ON faq_entries(guild,locale,published);`);
}

export function findFaq(db,guild,locale,query) {
  const normalize=value=>value.normalize('NFD').replace(/\p{Mark}/gu,'').toLowerCase();
  const terms=normalize(query).split(/\s+/).filter(Boolean);
  return db.prepare('SELECT question,answer FROM faq_entries WHERE guild=? AND locale=? AND published=1 ORDER BY question').all(guild,locale)
    .filter(entry=>terms.every(term=>normalize(entry.question+' '+entry.answer).includes(term))).slice(0,3);
}
