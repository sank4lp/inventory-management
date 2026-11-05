import bpy, bmesh, math, json
from mathutils import Matrix, Vector
from pathlib import Path

OUT=Path('/Users/sankalprajpoot/Documents/Personal/inventory-management/output/controller-enclosure')
def active(o):
    bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o
def clean(o):
    bm=bmesh.new();bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=0.00001)
    bmesh.ops.dissolve_degenerate(bm,edges=list(bm.edges),dist=0.00001)
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(o.data);bm.free();o.data.update()
def boolean(a,b,op='DIFFERENCE'):
    a.data.update();b.data.update();bpy.context.view_layer.update();active(a)
    m=a.modifiers.new(op+' '+b.name,'BOOLEAN');m.operation=op;m.object=b;m.solver='MANIFOLD'
    bpy.ops.object.modifier_apply(modifier=m.name)
    assert len(a.modifiers)==0, 'Unapplied boolean'
    bpy.data.objects.remove(b,do_unlink=True)
def mesh(name,verts,faces):
    me=bpy.data.meshes.new(name);me.from_pydata(verts,[],faces);me.update()
    o=bpy.data.objects.new(name,me);bpy.context.scene.collection.objects.link(o);clean(o);return o
def box(name,dims,loc):
    bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=name;o.dimensions=dims
    active(o);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);return o
def cyl(name,radius,depth,loc,rotation=None,radius_top=None):
    if radius_top is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=96,radius=radius,depth=depth,location=loc)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=96,radius1=radius,radius2=radius_top,depth=depth,location=loc)
    o=bpy.context.object;o.name=name
    if rotation is not None:o.matrix_world=Matrix.Translation(loc)@rotation
    return o
def rounded(name,w,h,r,z0,z1):
    pts=[]
    for cx,cy,a0 in [(w/2-r,h/2-r,0),(-w/2+r,h/2-r,90),(-w/2+r,-h/2+r,180),(w/2-r,-h/2+r,270)]:
        for i in range(17):
            a=math.radians(a0+i*90/16);pts.append((cx+r*math.cos(a),cy+r*math.sin(a)))
    n=len(pts);v=[(x,y,z) for z in (z0,z1) for x,y in pts]
    f=[tuple(reversed(range(n))),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    return mesh(name,v,f)
def stats(o):
    bm=bmesh.new();bm.from_mesh(o.data)
    d={'vertices':len(bm.verts),'faces':len(bm.faces),'nonmanifold_edges':sum(not e.is_manifold for e in bm.edges),'volume_mm3':bm.calc_volume(signed=True)};bm.free();return d

old=bpy.data.scenes['V17 FINAL -RS485 PowerIN LEDLine cable entries']
scene=bpy.data.scenes.new('V18 FINAL - shorter base and one-piece reinforced lid')
scene.unit_settings.system='METRIC';scene.unit_settings.scale_length=.001
bpy.context.window.scene=scene
base=bpy.data.objects['V17 BASE - three round labelled cable ports'].copy();base.data=base.data.copy();base.name='V18 BASE -10mm shorter -swapped lower labels';scene.collection.objects.link(base);base.matrix_world=Matrix.Identity(4)
for v in base.data.vertices:
    z=v.co.z
    if z>=43:v.co.z-=10
    elif z>28:v.co.z-=10*(z-28)/15
base.data.update()
for x in (-24,24):
    boolean(base,box('Restore previous lower engraving',(45,2.4,5.5),(x,-47.8,16.7)),'UNION')
for x,label in [(-24,'LED Line'),(24,'RS485 + GND')]:
    cu=bpy.data.curves.new(label,'FONT');cu.body=label;cu.align_x='CENTER';cu.size=4.5;cu.extrude=.35;cu.resolution_u=8;cu.fill_mode='BOTH'
    t=bpy.data.objects.new('Engrave '+label,cu);scene.collection.objects.link(t)
    t.matrix_world=Matrix.Translation((x,-48.75,14.5))@Matrix.Rotation(math.pi/2,4,'X')
    active(t);bpy.ops.object.convert(target='MESH');t=bpy.context.object;clean(t);boolean(base,t)
clean(base)

# A 2.4 mm roof plus shallow perimeter skirt replaces both acrylic frames.
lid=rounded('V18 LID -single printed cover with reinforced sockets',118,98,3,48.7,54.3)
boolean(lid,rounded('Underside recess',113.2,93.2,.6,48.6,51.9))
sx0=52.77817459305202;sy0=42.77817459305202
for sx in (-1,1):
    for sy in (-1,1):
        x=sx*sx0;y=sy*sy0;px=sx*41.5;py=sy*32.5
        boolean(lid,cyl('Local M4 seat',6,5.6,(x,y,51.5)),'UNION')
        # 8 mm socket foot grows to 12 mm at the cover; bore stays 3.4 mm.
        boolean(lid,cyl('Tapered socket support',4,33.25,(px,py,35.325),radius_top=6),'UNION')
        # Two outboard triangular ribs per support, clear of the base walls.
        for axis in ('X','Y'):
            if axis=='X':
                tri=[(px,28.0),(px,51.95),(sx*56.2,51.95)]
                vv=[(u,py+t,z) for t in (-1.2,1.2) for u,z in tri]
            else:
                tri=[(py,28.0),(py,51.95),(sy*46.2,51.95)]
                vv=[(px+t,u,z) for t in (-1.2,1.2) for u,z in tri]
            rib=mesh('Socket reinforcing rib',vv,[(2,1,0),(3,4,5),(0,1,4,3),(1,2,5,4),(2,0,3,5)])
            boolean(lid,rib,'UNION')
        boolean(lid,cyl('PCB pin blind socket',1.7,9.0,(px,py,23.1))) # 18.6..27.6
        boolean(lid,cyl('M4 passage',2,8,(x,y,51.5)))
        boolean(lid,cyl('Original LED screw head recess',5,.6,(x,y,54.1))) # floor 53.8

# Recover the existing logo floor exactly and extrude a new engraving tool.
src=bpy.data.objects['V17 OUTER LID -original LytGuide engraving']
faces=[p for p in src.data.polygons if all(abs(src.data.vertices[i].co.z-63.5)<.0002 for i in p.vertices)]
ids=sorted({i for p in faces for i in p.vertices});remap={j:i for i,j in enumerate(ids)}
assert len(ids)>500, 'Logo floor was not found'
floor=mesh('Original logo floor',[(src.data.vertices[i].co.x,src.data.vertices[i].co.y-41.5,0) for i in ids],[tuple(remap[i] for i in p.vertices) for p in faces])
bm=bmesh.new();bm.from_mesh(floor.data);bm.verts.ensure_lookup_table();bm.faces.ensure_lookup_table()
vv=[(v.co.x,v.co.y,53.5) for v in bm.verts];n=len(vv);vv += [(x,y,54.305) for x,y,z in vv]
ff=[]
for f in bm.faces:
    q=[v.index for v in f.verts];ff.append(tuple(reversed(q)));ff.append(tuple(i+n for i in q))
for e in bm.edges:
    if e.is_boundary:
        a,b=[v.index for v in e.verts];ff.append((a,b,b+n,a+n))
bm.free();bpy.data.objects.remove(floor,do_unlink=True)
logo=mesh('LytGuide original 0.8mm engraving',vv,ff);boolean(lid,logo);clean(lid)

mat=bpy.data.materials.get('ASA - pale grey')
if mat:lid.data.materials.append(mat)
base['PCB underside mm']=17.1;base['Thin pins mm']='diameter3 x height10';base['Upper seam mm']=48.7
lid['Socket mm']='OD8 foot / OD12 root; bore3.4; blind depth8.9'
lid['Clearance above PCB mm']=30.0;lid['Roof mm']=2.4;lid['Logo engraving mm']=.8
scene['Overall mm']='118 x98 x53.3';scene['Revision']='V18:10mm shorter;single printed lid;reinforced sockets;bottom labels swapped'
info={'base':stats(base),'lid':stats(lid),'old_printed_volume_mm3':sum(stats(bpy.data.objects[n])['volume_mm3'] for n in ['V17 BASE - three round labelled cable ports','V17 OUTER LID -original LytGuide engraving','V17 INNER RETAINER -unchanged'])}
assert info['base']['nonmanifold_edges']==0 and info['lid']['nonmanifold_edges']==0,info
(OUT/'v18-work'/'geometry-checks.json').write_text(json.dumps(info,indent=2))
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'controller-enclosure-V18-SHORTER-REINFORCED.blend'))
result=info
