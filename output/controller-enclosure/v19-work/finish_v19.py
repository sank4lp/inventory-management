import bpy,bmesh,math,json,zipfile,xml.etree.ElementTree as ET
from mathutils import Matrix,Vector
from pathlib import Path
OUT=Path('/Users/sankalprajpoot/Documents/Personal/inventory-management/output/controller-enclosure')
scene=bpy.data.scenes['V19 FINAL - ventilated controller enclosure'];bpy.context.window.scene=scene
base=bpy.data.objects['V19 BASE - four shielded side vents'];lid=bpy.data.objects['V19 LID - reinforced one-piece cover']
report=json.loads((OUT/'v19-work/geometry-checks.json').read_text())
# Two printable parts; base retains +Y/-Y cable-wall orientation.
ns='http://schemas.microsoft.com/3dmanufacturing/core/2015/02';ET.register_namespace('',ns)
def el(tag):return '{'+ns+'}'+tag
root=ET.Element(el('model'),{'unit':'millimeter','{http://www.w3.org/XML/1998/namespace}lang':'en-US'})
ET.SubElement(root,el('metadata'),{'name':'Title'}).text='LytGuide controller V19 - shielded passive ventilation'
ET.SubElement(root,el('metadata'),{'name':'Description'}).text='Vented base and one-piece solid lid. Mount Power IN end upward. Four offset side air passages. 256x256mm bed, 28mm minimum edge margin; 4mm part gap. No acrylic. Nominal M4 passages.'
res=ET.SubElement(root,el('resources'));build=ET.SubElement(root,el('build'))
worldverts=[]
for oid,o,R,tx,ty in [(1,base,Matrix.Identity(4),69,28),(2,lid,Matrix.Rotation(math.pi,4,'X'),69,130)]:
    coords=[R@v.co for v in o.data.vertices];mins=Vector(tuple(min(v[k] for v in coords) for k in range(3)))
    coords=[v-mins for v in coords]
    obj=ET.SubElement(res,el('object'),{'id':str(oid),'type':'model','name':o.name});me=ET.SubElement(obj,el('mesh'));vs=ET.SubElement(me,el('vertices'));ts=ET.SubElement(me,el('triangles'))
    for v in coords:
        ET.SubElement(vs,el('vertex'),dict(zip(('x','y','z'),(f'{c:.6f}' for c in v))))
        worldverts.append((v.x+tx,v.y+ty,v.z))
    o.data.calc_loop_triangles()
    for t in o.data.loop_triangles:ET.SubElement(ts,el('triangle'),dict(zip(('v1','v2','v3'),(str(i) for i in t.vertices))))
    ET.SubElement(build,el('item'),{'objectid':str(oid),'transform':f'1 0 0 0 1 0 0 0 1 {tx} {ty} 0'})
fname=OUT/'controller-enclosure-V19-VENTILATED-256x256.3mf'
with zipfile.ZipFile(fname,'w',zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml','<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
    z.writestr('_rels/.rels','<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    z.writestr('3D/3dmodel.model',ET.tostring(root,encoding='utf-8',xml_declaration=True))
with zipfile.ZipFile(fname) as z:assert z.testzip() is None;assert len(ET.fromstring(z.read('3D/3dmodel.model')).find(el('build')))==2
assert all(-.0001<=v[0]<=256.0001 and -.0001<=v[1]<=256.0001 and v[2]>=-.0001 for v in worldverts)
report['bed_bounds_mm']=[[min(v[k] for v in worldverts),max(v[k] for v in worldverts)] for k in range(3)]
report['print_parts']=2;report['minimum_edge_margin_mm']=28
(OUT/'v19-work'/'geometry-checks.json').write_text(json.dumps(report,indent=2))

# Put the two editable parts side by side, with the lid interior visible.
base.matrix_world=Matrix.Translation((-70,0,0))
lid.matrix_world=Matrix.Translation((70,0,55.3))@Matrix.Rotation(math.pi,4,'X')
mat=bpy.data.materials.get('V19 warm grey') or bpy.data.materials.new('V19 warm grey');mat.diffuse_color=(.42,.49,.53,1);mat.use_nodes=True
bs=mat.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(.42,.49,.53,1);bs.inputs['Roughness'].default_value=.65
for o in (base,lid):
    o.data.materials.clear();o.data.materials.append(mat)
    for p in o.data.polygons:p.material_index=0
scene.world=bpy.data.worlds.get('Controller studio')
def cam(name,loc,target,scale):
    data=bpy.data.cameras.new(name);data.type='ORTHO';data.ortho_scale=scale
    ob=bpy.data.objects.new(name,data);scene.collection.objects.link(ob);ob.location=loc;ob.rotation_euler=(Vector(target)-ob.location).to_track_quat('-Z','Y').to_euler();return ob
camera=cam('V19 side-by-side camera',(145,-290,310),(0,0,19),310);scene.camera=camera
for name,loc,power,size in [('Key',(-100,-150,250),1600000,190),('Fill',(100,20,220),1100000,160),('Rim',(-100,160,180),900000,150)]:
    d=bpy.data.lights.new('V19 '+name,'AREA');d.energy=power;d.shape='DISK';d.size=size
    o=bpy.data.objects.new('V19 '+name,d);scene.collection.objects.link(o);o.location=loc;o.rotation_euler=(Vector((0,0,10))-o.location).to_track_quat('-Z','Y').to_euler()
scene.render.engine='CYCLES';scene.cycles.samples=32;scene.cycles.use_denoising=True;scene.render.resolution_x=1600;scene.render.resolution_y=1100;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.film_transparent=False
scene.view_settings.view_transform='AgX';scene.render.filepath=str(OUT/'controller-v19-open.png')
for area in bpy.context.screen.areas:
    if area.type=='VIEW_3D':
        sp=area.spaces.active;sp.overlay.show_floor=False;sp.region_3d.view_perspective='ORTHO';sp.region_3d.view_location=(0,0,18);sp.region_3d.view_distance=320;sp.region_3d.view_rotation=camera.rotation_euler.to_quaternion()
bpy.ops.object.select_all(action='DESELECT');lid.select_set(True);bpy.context.view_layer.objects.active=lid

bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'controller-enclosure-V19-VENTILATED.blend'))
result={'checks':report,'3mf':str(fname),'blend':bpy.data.filepath,'render_ready':scene.render.filepath}
