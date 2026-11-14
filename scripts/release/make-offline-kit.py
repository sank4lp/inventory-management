#!/usr/bin/env python3
"""Create one checked offline Pi kit with separately matched OS dependencies."""
import argparse,hashlib,json,pathlib,re,shutil,tarfile
from standalone_uninstaller import generate as generate_uninstaller

def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as stream:
  while block:=stream.read(1024*1024):h.update(block)
 return h.hexdigest()

def write_archive(folder,archive):
 def executable_launchers(info):
  if pathlib.PurePosixPath(info.name).name in ('Install LytGuide.run','Uninstall LytGuide.run','install.sh'):
   info.mode=0o755
  return info
 with tarfile.open(archive,'w:gz',compresslevel=1) as tar:tar.add(folder,arcname=folder.name,filter=executable_launchers)
 pathlib.Path(str(archive)+'.sha256').write_text(digest(archive)+'  '+archive.name+'\n')

def control_text(path):
 with path.open('rb') as stream:
  if stream.read(8)!=b'!<arch>\n':raise ValueError('Invalid Debian package')
  while header:=stream.read(60):
   size=int(header[48:58]);name=header[:16].decode().strip().rstrip('/')
   if name.startswith('control.tar'):
    import io
    with tarfile.open(fileobj=io.BytesIO(stream.read(size)),mode='r:*') as archive:
     return archive.extractfile('./control').read().decode()
   stream.seek(size+(size%2),1)
 raise ValueError('Missing package control')

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--package',required=True);parser.add_argument('--dependencies',required=True,action='append');parser.add_argument('--output',required=True);args=parser.parse_args()
 project=pathlib.Path(__file__).resolve().parents[2];package=pathlib.Path(args.package).resolve();out=pathlib.Path(args.output).resolve()
 repositories={}
 for folder in args.dependencies:
  deps=pathlib.Path(folder).resolve();info=json.loads((deps/'dependencies.json').read_text());suite=info['suite']
  if suite not in ('bookworm','trixie') or info['architecture']!='arm64':raise ValueError('Bookworm or Trixie ARM64 dependencies required')
  if suite in repositories:raise ValueError('Duplicate OS dependency set: '+suite)
  repositories[suite]=(deps,info)
 control=control_text(package);fields=dict(line.split(': ',1) for line in control.splitlines() if ': ' in line and not line.startswith(' '));version=fields['Version']
 if fields['Package']!='lytguide-test' or fields['Architecture']!='arm64':raise ValueError('Wrong application package')
 name='Pi' if len(repositories)>1 else next(iter(repositories)).title()
 folder=out/('LytGuide-'+name+'-arm64-'+version)
 if folder.exists():raise ValueError('That kit already exists; use a fresh version')
 folder.mkdir(parents=True);packages=folder/'packages';packages.mkdir()
 shutil.copy2(package,packages/package.name)
 for suite,(deps,info) in sorted(repositories.items()):
  target=packages/suite;target.mkdir()
  for item in info['files']:
   source=deps/item['filename']
   if source.parent!=deps or digest(source)!=item['sha256']:raise ValueError('Offline dependency mismatch: '+item['filename'])
   shutil.copy2(source,target/source.name)
  # The installer copies only this OS set plus the shared app into its local repo.
  index=(deps/'Packages').read_text().rstrip()+'\n\n'+control.rstrip()+'\n'
  index+='Filename: ./'+package.name+'\nSize: '+str(package.stat().st_size)+'\nSHA256: '+digest(package)+'\n\n'
  (target/'Packages').write_text(index)
 shutil.copy2(project/'scripts/release/install-offline.sh',folder/'install.sh')
 shutil.copy2(project/'scripts/release/install-launch.sh',folder/'Install LytGuide.run')
 generate_uninstaller(pathlib.Path(str(package)+'.uninstall.cjs'),pathlib.Path(str(package)+'.portable-backup.py'),project/'scripts/release/uninstall-launch.sh',folder/'Uninstall LytGuide.run')
 shutil.copy2(pathlib.Path(str(package)+'.uninstall.cjs'),folder/'uninstall.cjs')
 shutil.copy2(pathlib.Path(str(package)+'.portable-backup.py'),folder/'portable-backup.py')
 (folder/'Uninstall LytGuide.run').chmod(0o755)
 (folder/'install.sh').chmod(0o755);(folder/'Install LytGuide.run').chmod(0o755)
 (folder/'version').write_text(version+'\n')
 (folder/'suites').write_text(''.join(suite+'\n' for suite in sorted(repositories)))
 guide=(project/'docs/pi-test-installer.md').read_text()
 # Keep the customer instructions identical in the source, installed package
 # and offline folder; plain text opens without a Markdown reader on the Pi.
 plain=re.sub(r'^```[^\n]*$', '', guide, flags=re.MULTILINE)
 plain=re.sub(r'^#{1,6}\s+', '', plain, flags=re.MULTILINE).replace('**','').replace('`','')
 (folder/'START HERE.txt').write_text(plain)
 files=sorted(path for path in folder.rglob('*') if path.is_file())
 (folder/'SHA256SUMS').write_text(''.join(digest(path)+'  '+str(path.relative_to(folder))+'\n' for path in files))
 archive=pathlib.Path(str(folder)+'.tar.gz')
 write_archive(folder,archive)
 print(json.dumps({'folder':str(folder),'archive':str(archive),'version':version,'dependencies':{suite:len(info['files']) for suite,(_,info) in repositories.items()},'bytes':archive.stat().st_size,'sha256':digest(archive)},indent=2))
if __name__=='__main__':main()
