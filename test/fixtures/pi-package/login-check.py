#!/usr/bin/env python3
"""Verify restored sign-in, pages, assets and actual warehouse work over HTTPS."""
import http.cookiejar,json,os,pathlib,sqlite3,ssl,urllib.request,urllib.parse,uuid
if not os.environ.get('LYTGUIDE_DISPOSABLE_CONTAINER'):raise SystemExit('Disposable check only')
c=json.loads(pathlib.Path('/etc/lytguide-test/config.json').read_text());origin='https://'+c['address']+':'+str(c['httpsPort'])
context=ssl.create_default_context(cafile='/transfer/root.crt');jar=http.cookiejar.CookieJar();opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar),urllib.request.HTTPSHandler(context=context))
r=urllib.request.Request(origin+'/login',data=urllib.parse.urlencode({'username':'recoveredowner','password':'test-admin-only-password-2026'}).encode(),headers={'Origin':origin})
with opener.open(r) as response:
 page=response.read();assert urllib.parse.urlparse(response.url).path=='/work',response.url
 assert b'recoveredowner' in page or b'Recovered Owner' in page
assert any(cookie.name=='session' and cookie.secure for cookie in jar)
def get(path):
 with opener.open(origin+path) as response:assert response.status==200,path;return response.read()
def data(path):return json.loads(get(path))
def command(action,**input):
 body={'requestId':str(uuid.uuid4()),'deviceId':'packaged-https-validation',**input}
 request=urllib.request.Request(origin+'/api/work/'+action,data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Origin':origin})
 with opener.open(request) as response:assert response.status==200;return json.load(response)
def total():
 db=sqlite3.connect('/var/lib/lytguide-test/data/inventory.db')
 try:return db.execute('SELECT SUM(available_quantity) FROM inventory_balances').fetchone()[0]
 finally:db.close()
assert total()==4
for path in ['/work','/work/history','/work/task-history','/work/active-assignments','/record-movement','/recommended-actions','/products','/cells','/stocktaking','/reports','/settings/people','/settings/roles','/devices','/location-setup','/admin/product-fields','/backups','/work/timing','/settings/system','/profile']:
 get(path)
for path in ['/styles.css','/ui-template.css','/app.js','/sw.js','/client/work.js','/client/vendor/jsQR.js']:get(path)
db=sqlite3.connect('/var/lib/lytguide-test/data/inventory.db');product,cell=db.execute('SELECT product_id,cell_id FROM inventory_balances WHERE available_quantity>0 ORDER BY cell_id LIMIT 1').fetchone();db.close()
assert b'<svg' in get('/labels/'+str(cell)+'.svg')
snapshot=data('/api/work/snapshot');p=next(p for p in snapshot['products'] if p['id']==product)
put={'requestId':str(uuid.uuid4()),'productId':product,'unit':p['unit_of_measure'],'confirmed':True,'rows':[{'direction':'put','cellId':cell,'quantity':1}]}
assert command('recordMovement',**put)['status']=='recorded';assert total()==5
created=command('create',direction='pick',quantity=1,productId=product,preferredCellId=cell)
def task():return next(t for t in data('/api/work/snapshot?taskId='+str(created['taskId']))['tasks'] if t['id']==created['taskId'])
for original in task()['lines']:
 if original['execution_state']!='ready':continue
 line=next(l for l in task()['lines'] if l['id']==original['id'])
 command('acquire',lineId=line['id'],revision=line['revision'],method='arrival')
 line=next(l for l in task()['lines'] if l['id']==original['id'])
 result=command('report',lineId=line['id'],revision=line['revision'],assignmentGeneration=line['current_generation'],cellId=line['cell_id'],unit=line['unit_of_measure'],quantity=line['planned_quantity'],method='manual',manualReason='Disposable packaged HTTPS check',cellCompletion=True)
 assert result['status']=='recorded',result
assert task()['outcome']=='completed';assert total()==4
assert command('recordMovement',**put)['replayed'];assert total()==4
print('PASS restored HTTPS sign-in, secure session, 19 pages, assets, QR, recorded Put, completed Pick and replay without double counting')
