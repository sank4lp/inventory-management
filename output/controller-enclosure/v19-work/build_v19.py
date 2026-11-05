from pathlib import Path
OUT=Path('/Users/sankalprajpoot/Documents/Personal/inventory-management/output/controller-enclosure')
exec((OUT/'v18-work/build_v18.py').read_text().split('old=bpy.data.scenes')[0])

scene=bpy.data.scenes.new('V19 FINAL - ventilated controller enclosure')
scene.unit_settings.system='METRIC';scene.unit_settings.scale_length=.001
bpy.context.window.scene=scene
def copy_part(source,name):
    o=bpy.data.objects[source].copy();o.data=o.data.copy();o.name=name
    scene.collection.objects.link(o);o.matrix_world=Matrix.Identity(4);return o
base=copy_part('V18 BASE -10mm shorter -swapped lower labels','V19 BASE - four shielded side vents')
lid=copy_part('V18 LID -single printed cover with reinforced sockets','V19 LID - reinforced one-piece cover')

def prism(name,points,axis,a,b,sx=1):
    if axis=='Y':v=[(sx*p,y,z) for y in (a,b) for p,z in points]
    elif axis=='U':v=[(sx*u,p,z) for u in (a,b) for p,z in points]
    else:v=[(sx*u,y,z) for z in (a,b) for u,y in points]
    n=len(points)
    f=[tuple(reversed(range(n))),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    return mesh(name,v,f)

vents=[]
for sx in (-1,1):
    for ylo,yhi in [(-28,-8),(8,28)]:
        # The added inner wall grows from the existing wall on a 45-degree ramp.
        block=prism('Vent outer envelope',[(56.5,7),(59,7),(59,41),(51.8,41),(51.8,11.7)],'Y',ylo,yhi,sx)
        boolean(base,block,'UNION')
        # A peaked roof closes progressively in the base's print orientation.
        channel=prism('Offset ventilation channel',[(53.4,14),(57.4,14),(57.4,36),(55.4,38),(53.4,36)],'Y',ylo+2,yhi-2,sx)
        # Leave a drainage slope leading toward the lower outside opening.
        ramp=prism('Drainage slope',[(53.4,ylo+2),(55.8,ylo+2),(53.4,ylo+4.4)],'Z',13.9,38.1,sx)
        boolean(channel,ramp)
        boolean(base,channel)
        entrance=prism('Lower external vent mouth',[(ylo+2,14),(ylo+6,14),(ylo+6,36),(ylo+4,38),(ylo+2,36)],'U',55.8,60,sx)
        boolean(base,entrance)
        outlet=prism('Higher internal vent mouth',[(yhi-6,14),(yhi-2,14),(yhi-2,36),(yhi-4,38),(yhi-6,36)],'U',51,55,sx)
        boolean(base,outlet)
        vents.append({'side':sx,'y_limits_mm':[ylo,yhi],'outer_opening_y_mm':[ylo+2,ylo+6],'inner_opening_y_mm':[yhi-6,yhi-2],'opening_area_mm2':92,'roof_slope_deg':45})
clean(base)

report={'base':stats(base),'lid':stats(lid),'vents':vents}
for key,o in [('base',base),('lid',lid)]:
    assert report[key]['nonmanifold_edges']==0,report
    adj=[[] for v in o.data.vertices]
    for e in o.data.edges:
        a,b=e.vertices;adj[a].append(b);adj[b].append(a)
    unseen=set(range(len(adj)));components=0
    while unseen:
        components+=1;stack=[unseen.pop()]
        while stack:
            for j in adj[stack.pop()]:
                if j in unseen:unseen.remove(j);stack.append(j)
    assert components==1,(key,components)
    report[key]['connected_components']=components

# Check a continuous three-segment air path in every bank and a shielding wall.
def unobstructed(o,a,b):
    a=Vector(a);d=Vector(b)-a
    return not o.ray_cast(a,d.normalized(),distance=d.length)[0]
for vent in vents:
    sx=vent['side'];lo,hi=vent['y_limits_mm']
    points=[(sx*60,lo+4,25),(sx*56.6,lo+4,25),(sx*54.2,hi-4,25),(sx*51,hi-4,25)]
    assert all(unobstructed(base,a,b) for a,b in zip(points,points[1:])),vent
    assert not unobstructed(base,points[0],(sx*50,lo+4,25)),vent
report['air_paths_open']=4;report['straight_inward_paths_blocked']=4

# Verify all locating pins and blind sockets retain their established dimensions.
report['pin_top_z_mm']=[];report['socket_floor_z_mm']=[]
for x in (-41.5,41.5):
    for y in (-32.5,32.5):
        hit,p,n,i=base.ray_cast(Vector((x,y,30)),Vector((0,0,-1)))
        assert hit and abs(p.z-27.1)<.001
        report['pin_top_z_mm'].append(round(p.z,4))
        hit,p,n,i=lid.ray_cast(Vector((x,y,18.5)),Vector((0,0,1)))
        assert hit and abs(p.z-27.6)<.001
        report['socket_floor_z_mm'].append(round(p.z,4))
collision=base.copy();collision.data=base.data.copy();scene.collection.objects.link(collision)
cutter=lid.copy();cutter.data=lid.data.copy();scene.collection.objects.link(cutter)
boolean(collision,cutter,'INTERSECT')
overlap=abs(stats(collision)['volume_mm3']);bpy.data.objects.remove(collision,do_unlink=True)
assert overlap<.001,overlap
report['assembly_solid_overlap_mm3']=overlap
report['overall_mm']=[118,98,53.3]
report['minimum_headroom_above_PCB_mm']=30
report['PCB_thickness_mm']=1.6
report['mounting_orientation']='Power IN (+Y) end upwards; lid faces outward'
report['new_printed_volume_mm3']=sum(report[k]['volume_mm3'] for k in ['base','lid'])
old=json.loads((OUT/'v18-work/geometry-checks.json').read_text())
report['volume_change_from_V18_percent']=100*(report['new_printed_volume_mm3']/old['new_printed_volume_mm3']-1)
base['Ventilation']='Four offset side passages, 4mm mouths, 45deg roofs, mount Power IN end up'
scene['Revision']='V19: V18 dimensions and fittings retained; shielded passive vents added'
scene['Overall mm']='118 x 98 x 53.3'
(OUT/'v19-work/geometry-checks.json').write_text(json.dumps(report,indent=2))
result=report
