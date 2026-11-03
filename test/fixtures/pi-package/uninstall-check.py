#!/usr/bin/env python3
"""Disposable warehouse uninstall checks; never run on a real warehouse."""
import hashlib,json,os,pathlib,sqlite3,subprocess,sys,http.cookiejar,ssl,urllib.request,urllib.parse,uuid
if os.environ.get('LYTGUIDE_DISPOSABLE_CONTAINER')!='1':raise SystemExit('Disposable check only')
root=pathlib.Path('/var/lib/lytguide-test');card=pathlib.Path('/boot/firmware/LYTGUIDE-RECOVERY');saved=pathlib.Path('/transfer/uninstall-state.json')
mode=sys.argv[1]
def hashes():return {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in card.glob('*.lytbackup')}
def launch(answer):return subprocess.run(['sh',os.environ.get('LYTGUIDE_UNINSTALL_KIT','/tmp/lytguide-uninstall-qa')+'/Uninstall LytGuide.run','--terminal'],input=answer+'\n\n',capture_output=True,text=True,timeout=300)
if mode=='seed':
 db=sqlite3.connect(root/'data/inventory.db');db.execute('PRAGMA foreign_keys=ON');admin=db.execute("SELECT id FROM users WHERE role='admin' LIMIT 1").fetchone()[0];cell=db.execute('SELECT id FROM cells ORDER BY id LIMIT 1').fetchone()[0]
 product=db.execute("INSERT INTO products(sku,name,brand,unit_of_measure,items_per_cell,created_at) VALUES('UNINSTALL-QA','Recovery stock','QA','pieces',12,datetime('now'))").lastrowid
 db.execute('INSERT INTO inventory_balances(product_id,cell_id,available_quantity,reserved_quantity) VALUES(?,?,3,3)',(product,cell))
 task=db.execute("INSERT INTO tasks(type,status,summary,created_by,started_at,last_touched_at,workflow_version,assignee_id,assigned_by,assigned_at,requested_quantity,outcome,review_followup,attention,guidance_paused) VALUES('pick','pending_review','Partly completed pick',?,datetime('now'),datetime('now'),2,?,?,datetime('now'),5,'needs_review',1,1,1)",(admin,admin,admin)).lastrowid
 line=db.execute("INSERT INTO task_lines(task_id,product_id,cell_id,planned_quantity,actual_quantity,guidance_color,execution_state,physical_confirmed_at,unit_of_measure) VALUES(?,?,?,5,2,'green','settled',datetime('now'),'pieces')",(task,product,cell)).lastrowid;db.execute("INSERT INTO work_reservations(line_id,kind,quantity,state) VALUES(?,'pick',3,'held')",(line,));db.execute("INSERT INTO transactions(type,product_id,cell_id,quantity_delta,user_id,task_id,reason,created_at) VALUES('pick',?,?,-2,?,?,'Recorded before uninstall',datetime('now'))",(product,cell,admin,task));db.commit()
 value={table:db.execute('SELECT * FROM '+table+' ORDER BY 1').fetchall() for table in ['products','cells','controllers','inventory_balances','location_labels','transactions']};value['users']=db.execute('SELECT username,password_hash,role,status FROM users ORDER BY id').fetchall();value['partial']=[task,product,cell];value['authority']=hashlib.sha256((root/'caddy/pki/authorities/local/root.crt').read_bytes()).hexdigest();db.close();saved.write_text(json.dumps(value));print('PASS seeded saved stock, QR/hardware mapping and a task with 2 picked out of 5',flush=True)
elif mode=='real-seed':
 config=json.loads(pathlib.Path('/etc/lytguide-test/config.json').read_text());origin='https://'+config['address']+':'+str(config['httpsPort']);jar=http.cookiejar.CookieJar();opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar),urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=str(root/'caddy/pki/authorities/local/root.crt'))))
 with opener.open(urllib.request.Request(origin+'/login',data=urllib.parse.urlencode({'username':'qaowner','password':'test-admin-only-password-2026'}).encode(),headers={'Origin':origin})) as response:assert urllib.parse.urlparse(response.url).path=='/work'
 db=sqlite3.connect(root/'data/inventory.db');product,cell=db.execute('SELECT product_id,cell_id FROM inventory_balances WHERE available_quantity>=3 LIMIT 1').fetchone();db.close()
 def command(name,**values):
  request=urllib.request.Request(origin+'/api/work/'+name,data=json.dumps({'requestId':str(uuid.uuid4()),'deviceId':'uninstall-physical-work',**values}).encode(),headers={'Content-Type':'application/json','Origin':origin})
  with opener.open(request) as response:return json.load(response)
 def task_row(task):
  with opener.open(origin+'/api/work/snapshot?taskId='+str(task)) as response:return next(row for row in json.load(response)['tasks'] if row['id']==task)
 task=command('create',direction='pick',quantity=3,productId=product,preferredCellId=cell)['taskId'];line=task_row(task)['lines'][0];command('acquire',lineId=line['id'],revision=line['revision'],method='arrival');line=task_row(task)['lines'][0]
 command('report',lineId=line['id'],revision=line['revision'],assignmentGeneration=line['current_generation'],cellId=cell,unit=line['unit_of_measure'],quantity=1,method='manual',manualReason='Verified physical movement before uninstall',cellCompletion=True,differenceConfirmed=True)
 db=sqlite3.connect(root/'data/inventory.db');assert db.execute('SELECT actual_quantity FROM task_lines WHERE task_id=?',(task,)).fetchone()[0]==1
 value={table:db.execute('SELECT * FROM '+table+' ORDER BY 1').fetchall() for table in ['products','cells','controllers','inventory_balances','location_labels','transactions']};value['users']=db.execute('SELECT username,password_hash,role,status FROM users ORDER BY id').fetchall();value['partial']=[task,product,cell,3,1];value['authority']=hashlib.sha256((root/'caddy/pki/authorities/local/root.crt').read_bytes()).hexdigest();db.close();saved.write_text(json.dumps(value));print('PASS actual HTTPS Pick recorded 1 of 3 and saved a self-consistent warehouse baseline',flush=True)
elif mode=='failure':
 before=hashes();key=root/'caddy/pki/authorities/local/root.key';holding=key.with_suffix('.qa-holding');key.rename(holding)
 try:
  result=launch('');assert result.returncode!=0,(result.stdout,result.stderr);assert 'incomplete' in result.stderr,(result.stdout,result.stderr);assert root.exists() and pathlib.Path('/opt/lytguide-test').exists() and pathlib.Path('/etc/lytguide-test/config.json').exists();assert before==hashes()
 finally:holding.rename(key)
 print('PASS backup failure leaves the application and data installed, and preserves prior backups',flush=True)
elif mode in ['keep','delete']:
 before=hashes();result=launch('' if mode=='keep' else 'Y');print(result.stdout,flush=True);assert result.returncode==0,result.stderr
 for path in ['/opt/lytguide-test','/var/lib/lytguide-test','/etc/lytguide-test','/usr/bin/lytguide-test','/usr/share/applications/com.lytguide.Warehouse.desktop']:assert not pathlib.Path(path).exists(),path
 if mode=='keep':
  kept=list(card.glob('LytGuide-Uninstall-*.lytbackup'));assert kept
  for name,digest in before.items():assert hashlib.sha256((card/name).read_bytes()).hexdigest()==digest
  pathlib.Path('/transfer/uninstall-backup-path').write_text(str(max(kept,key=lambda p:p.stat().st_mtime_ns)))
 else:assert not list(card.glob('LytGuide-*.lytbackup'))
 print('PASS complete uninstall with '+('retained latest and previous backups' if mode=='keep' else 'explicit deletion of managed backups'),flush=True)
elif mode=='restored':
 expected=json.loads(saved.read_text());db=sqlite3.connect(root/'data/inventory.db')
 for table in ['products','cells','controllers','inventory_balances','location_labels','transactions']:
  actual=json.loads(json.dumps(db.execute('SELECT * FROM '+table+' ORDER BY 1').fetchall()));original=expected[table]
  if table=='controllers':
   # A live controller refreshes its heartbeat after the restored service starts.
   column=[row[1] for row in db.execute('PRAGMA table_info(controllers)')].index('last_seen_at');actual=[[value for i,value in enumerate(row) if i!=column] for row in actual];original=[[value for i,value in enumerate(row) if i!=column] for row in original]
  assert actual==original,table
 assert json.loads(json.dumps(db.execute('SELECT username,password_hash,role,status FROM users ORDER BY id').fetchall()))==expected['users']
 task,product,cell,*totals=expected['partial'];requested,actual=totals or [5,2];assert db.execute('SELECT actual_quantity FROM task_lines WHERE task_id=?',(task,)).fetchone()[0]==actual;assert db.execute('SELECT requested_quantity,outcome FROM tasks WHERE id=?',(task,)).fetchone()==(requested,'needs_review');db.close();assert hashlib.sha256((root/'caddy/pki/authorities/local/root.crt').read_bytes()).hexdigest()==expected['authority'];print('PASS restored inventory, accounts, QR/controller mapping, movement history, partial task quantities and phone trust',flush=True)
