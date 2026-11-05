import json, pathlib, subprocess, sys
ROOT=pathlib.Path('/Applications/BambuStudio.app/Contents/Resources/profiles/BBL')
OUT=pathlib.Path(__file__).resolve().parent/'slicing-comparison'
OUT.mkdir(exist_ok=True)
index={p.stem:p for p in ROOT.rglob('*.json')}
def resolve(name):
    d=json.loads(index[name].read_text());r={}
    if d.get('inherits'):r.update(resolve(d['inherits']))
    for inc in d.get('include',[]):r.update(resolve(inc))
    r.update(d);r.pop('include',None);r.pop('inherits',None)
    return r
def write(name,d):
    p=OUT/name;p.write_text(json.dumps(d,indent=2));return p
machine=resolve('Bambu Lab P1S 0.4 nozzle');machine['inherits']=''
machine_path=write('machine.json',machine)
filament=resolve('Generic ASA');filament['inherits']=''
filament_path=write('filament.json',filament)
for h,preset in [('016','0.16mm High Quality @BBL X1C'),('024','0.24mm Draft @BBL X1C'),('028','0.28mm Extra Draft @BBL X1C')]:
    proc=resolve(preset);proc['inherits']='';proc['curr_bed_type']='Textured PEI Plate'
    write('process-'+h+'.json',proc)
print(json.dumps({'profiles':str(OUT),'filament_max_volumetric_speed':filament.get('filament_max_volumetric_speed'),'layers':{h:json.loads((OUT/('process-'+h+'.json')).read_text()).get('layer_height') for h in ['016','024','028']}}))
