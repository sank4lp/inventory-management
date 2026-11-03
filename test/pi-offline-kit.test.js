import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {supportedOs,SUPPORTED_OS_SUITES} from '../scripts/release/supported-os.mjs';

test('OS support names tested releases explicitly rather than accepting unknown future or older distributions',()=>{
  assert.deepEqual(SUPPORTED_OS_SUITES,['bookworm','trixie']);
  for(const ID of ['debian','raspbian'])for(const VERSION_CODENAME of SUPPORTED_OS_SUITES)assert.equal(supportedOs({ID,VERSION_CODENAME}),true);
  for(const os of [{ID:'debian',VERSION_CODENAME:'bullseye'},{ID:'debian',VERSION_CODENAME:'forky'},{ID:'ubuntu',VERSION_CODENAME:'trixie'},{}])assert.equal(supportedOs(os),false);
});

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'lytguide-multi-kit-')),payload=join(root,'payload'),control=join(root,'control'),packagePath=join(root,'lytguide-test_1.0_arm64.deb');
  mkdirSync(payload);mkdirSync(control);writeFileSync(join(payload,'README'),'synthetic package only');
  writeFileSync(join(control,'control'),'Package: lytguide-test\nVersion: 1.0\nArchitecture: arm64\nDescription: Synthetic offline kit test\n');
  const made=spawnSync('python3',['scripts/release/make-archives.py','deb',payload,packagePath,'--control',control,'--epoch','1'],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);
  writeFileSync(packagePath+'.uninstall.cjs','// synthetic standalone uninstall payload');writeFileSync(packagePath+'.portable-backup.py','# synthetic backup helper');
  const dependencies={};
  for(const suite of SUPPORTED_OS_SUITES){
    const folder=join(root,suite),name='fixture_'+suite+'_arm64.deb',bytes=Buffer.from('synthetic dependency: '+suite);mkdirSync(folder);
    writeFileSync(join(folder,name),bytes);writeFileSync(join(folder,'Packages'),'Package: fixture-'+suite+'\nFilename: ./'+name+'\n\n');
    writeFileSync(join(folder,'dependencies.json'),JSON.stringify({suite,architecture:'arm64',files:[{filename:name,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}]}));dependencies[suite]=folder;
  }
  const build=(names,out='output')=>spawnSync('python3',['scripts/release/make-offline-kit.py','--package',packagePath,...names.flatMap(name=>['--dependencies',dependencies[name]]),'--output',join(root,out)],{encoding:'utf8'});
  return {root,packagePath,dependencies,build};
}

test('one offline kit shares the application and keeps each OS dependency repository separate and checksummed',()=>{
  const f=fixture();try{
    const run=f.build(SUPPORTED_OS_SUITES);assert.equal(run.status,0,run.stderr);const result=JSON.parse(run.stdout),folder=result.folder;
    const modes=spawnSync('python3',['-c','import sys,tarfile,json,pathlib; a=tarfile.open(sys.argv[1]); print(json.dumps({pathlib.PurePosixPath(m.name).name:m.mode for m in a if pathlib.PurePosixPath(m.name).name in ("Install LytGuide.run","Uninstall LytGuide.run","install.sh")}))',result.archive],{encoding:'utf8'});
    assert.equal(modes.status,0,modes.stderr);assert.deepEqual(JSON.parse(modes.stdout),{'Install LytGuide.run':0o755,'Uninstall LytGuide.run':0o755,'install.sh':0o755});
    for(const name of ['Uninstall LytGuide.run','uninstall.cjs','portable-backup.py'])assert.ok(existsSync(join(folder,name)));
    assert.equal(result.dependencies.bookworm,1);assert.equal(result.dependencies.trixie,1);
    assert.equal(readFileSync(join(folder,'suites'),'utf8'),'bookworm\ntrixie\n');
    assert.deepEqual(readdirSync(join(folder,'packages')).filter(name=>name.endsWith('.deb')),['lytguide-test_1.0_arm64.deb']);
    for(const suite of SUPPORTED_OS_SUITES){
      const own=join(folder,'packages',suite),other=suite==='bookworm'?'trixie':'bookworm';
      assert.ok(existsSync(join(own,'fixture_'+suite+'_arm64.deb')));assert.equal(existsSync(join(own,'fixture_'+other+'_arm64.deb')),false);
      const index=readFileSync(join(own,'Packages'),'utf8');assert.match(index,/Filename: \.\/lytguide-test_1.0_arm64\.deb/);assert.ok(!index.includes('fixture-'+other));
    }
    for(const line of readFileSync(join(folder,'SHA256SUMS'),'utf8').trim().split('\n')){
      const [expected,name]=line.split('  ');assert.equal(createHash('sha256').update(readFileSync(resolve(folder,name))).digest('hex'),expected,name);
    }
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('kit creation rejects duplicate OS sets and changed dependencies',()=>{
  const f=fixture();try{
    const duplicate=f.build(['bookworm','bookworm']);assert.notEqual(duplicate.status,0);assert.match(duplicate.stderr,/Duplicate OS dependency set/);
    writeFileSync(join(f.dependencies.bookworm,'fixture_bookworm_arm64.deb'),'changed');
    const changed=f.build(['bookworm'],'changed');assert.notEqual(changed.status,0);assert.match(changed.stderr,/Offline dependency mismatch/);
    const info=JSON.parse(readFileSync(join(f.dependencies.trixie,'dependencies.json'),'utf8'));info.suite='future';writeFileSync(join(f.dependencies.trixie,'dependencies.json'),JSON.stringify(info));
    const unsupported=f.build(['trixie'],'unsupported');assert.notEqual(unsupported.status,0);assert.match(unsupported.stderr,/Bookworm or Trixie ARM64/);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('the executable uninstaller embeds its version-matched program, helper and checksums for one-file copying',()=>{
 const f=fixture();try{
  const run=f.build(['bookworm']);assert.equal(run.status,0,run.stderr);const result=JSON.parse(run.stdout),file=join(result.folder,'Uninstall LytGuide.run');
  const source=readFileSync(file,'utf8');assert.match(source,/^#!\/bin\/sh/);assert.match(source,/__LYTGUIDE_UNINSTALL_PAYLOAD__/);assert.match(source,/mktemp -d \/tmp\/lytguide-uninstall/);
  const check=spawnSync('python3',['-c',"import sys,json,gzip,base64,pathlib,hashlib; p=pathlib.Path(sys.argv[1]); payload=p.read_bytes().split(b'\\n__LYTGUIDE_UNINSTALL_PAYLOAD__\\n',1)[1]; files=json.loads(gzip.decompress(base64.b64decode(payload))); assert set(files)=={'uninstall.cjs','portable-backup.py','Uninstall LytGuide.run','SHA256SUMS'}; assert all(hashlib.sha256(base64.b64decode(f['data'])).hexdigest()==f['sha256'] for f in files.values())",file],{encoding:'utf8'});assert.equal(check.status,0,check.stderr);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
