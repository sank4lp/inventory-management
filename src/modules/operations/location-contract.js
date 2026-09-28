// One description model for Work and future location commissioning.
export function describeLocation(db, cellId) {
  const cell = db.prepare('SELECT * FROM cells WHERE id=?').get(Number(cellId));
  if (!cell) throw new Error('Location not found.');
  const fields = db.prepare(`SELECT d.*,v.value_json FROM location_field_definitions d
    JOIN location_field_values v ON v.field_key=d.field_key WHERE v.cell_id=? ORDER BY d.display_order,d.field_key`).all(cell.id);
  const directions = fields.filter(f=>f.enabled && f.use_in_directions).map(f=>`${f.label} ${JSON.parse(f.value_json)}`);
  return { cellId:cell.id, code:cell.logical_code, name:cell.display_name || cell.logical_code,
    directions:[...directions, cell.display_name, cell.travel_instructions].filter(Boolean).join(', ') || cell.logical_code,
    descriptionRevision:cell.description_revision, bindingRevision:cell.binding_revision,
    labelId:cell.label_id,labelRevision:cell.label_revision, fields };
}

export function validLocationLabel(db, site, cell, value) {
  if (typeof value !== 'string' || value.length > 300) return false;
  if (value !== `lytguide:${site}:${cell.label_id}:${cell.label_revision}`) return false;
  const registered = db.prepare('SELECT * FROM location_labels WHERE token=?').get(cell.label_id);
  return !registered || registered.state === 'bound' && registered.cell_id === cell.cell_id && registered.revision === cell.label_revision;
}

export function saveLocationDescription(db, actor, input) {
  const cell=db.prepare('SELECT * FROM cells WHERE id=?').get(Number(input.cellId));
  if(!cell||cell.description_revision!==Number(input.descriptionRevision))throw new Error('Location details changed. Refresh before saving.');
  const name=String(input.displayName||'').trim(),travel=String(input.travelInstructions||'').trim();
  if(name.length>160||travel.length>1000||/[\u0000-\u001f]/.test(name))throw new Error('Use a readable name up to 160 characters and directions up to 1000 characters.');
  if(name&&db.prepare('SELECT 1 FROM cells WHERE id!=? AND active=1 AND (display_name=? COLLATE NOCASE OR logical_code=? COLLATE NOCASE)').get(cell.id,name,name))throw new Error('Another location already uses that name. Choose an unambiguous name.');
  // Definition editing/commissioning is Phase 2. Values use the same stable field keys now.
  for(const [key,value] of Object.entries(input.attributes||{})) {
    const field=db.prepare('SELECT * FROM location_field_definitions WHERE field_key=? AND enabled=1').get(key);
    if(!field)throw new Error('Unknown location field.');
    if(field.field_type==='number' && (String(value).trim()===''||!Number.isFinite(Number(value))))throw new Error(`Enter a number for ${field.label}.`);
    if(field.field_type==='select'&&!JSON.parse(field.options_json).includes(value))throw new Error(`Choose an option for ${field.label}.`);
    db.prepare('INSERT INTO location_field_values(cell_id,field_key,value_json) VALUES(?,?,?) ON CONFLICT(cell_id,field_key) DO UPDATE SET value_json=excluded.value_json').run(cell.id,key,JSON.stringify(field.field_type==='number'?Number(value):String(value)));
  }
  db.prepare('UPDATE cells SET display_name=?,travel_instructions=?,description_revision=description_revision+1 WHERE id=?').run(name||null,travel||null,cell.id);
  return {status:'recorded',message:'Location directions saved. Existing labels and stock identity are unchanged.'};
}
