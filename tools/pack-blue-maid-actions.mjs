// Pack approved artwork into stable-size runtime frames. No new artwork is synthesized here.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'packs/blue-maid')
const frameW=640,frameH=640,frames=[]
function box(image, ox, oy, w, h){let x0=w,y0=h,x1=-1,y1=-1;for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(image.data[((oy+y)*image.width+ox+x)*4+3]>32){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y)}if(x1<0)throw new Error('Empty action frame');return{x0,y0,x1,y1}}
function pack(name,image,ox,oy,w,h,groupBox,pin){
  const b=groupBox??box(image,ox,oy,w,h),scale=Math.min(464/(b.x1-b.x0+1),584/(b.y1-b.y0+1)),tile=new PNG({width:frameW,height:frameH})
  let left=(frameW-(b.x1-b.x0+1)*scale)/2,top=frameH-22-(b.y1-b.y0+1)*scale
  if(pin){left=frameW*.5-(pin.x-b.x0)*scale;top=40-(pin.y-b.y0)*scale}
  // Bilinear filter with premultiplied alpha keeps transparent edge pixels clean.
  for(let y=0;y<frameH;y++)for(let x=0;x<frameW;x++){
    const sx=b.x0+(x-left)/scale,sy=b.y0+(y-top)/scale;if(sx<b.x0||sy<b.y0||sx>b.x1||sy>b.y1)continue
    const ix=Math.floor(sx),iy=Math.floor(sy),fx=sx-ix,fy=sy-iy;let a=0,r=0,g=0,blue=0
    for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){const xx=Math.min(w-1,ix+dx),yy=Math.min(h-1,iy+dy),i=((oy+yy)*image.width+ox+xx)*4,weight=(dx?fx:1-fx)*(dy?fy:1-fy),alpha=image.data[i+3]*weight;a+=alpha;r+=image.data[i]*alpha;g+=image.data[i+1]*alpha;blue+=image.data[i+2]*alpha}
    const i=(y*frameW+x)*4;tile.data[i]=a?r/a:0;tile.data[i+1]=a?g/a:0;tile.data[i+2]=a?blue/a:0;tile.data[i+3]=a
  }
  const extra=pin?{pivot:{x:.5,y:40/frameH}}:{}
  if(name.startsWith('sleep-curl'))extra.revealY=Math.min(.95,(top+(h*.66-b.y0)*scale)/frameH)
  frames.push({name,tile,extra})
}
const ref=PNG.sync.read(fs.readFileSync(path.join(dir,'reference-sheet.png'))),cuts=[0,Math.round(ref.width*.355),Math.round(ref.width*.64),ref.width]
for(let i=0;i<3;i++)pack(['front','side','back'][i],ref,cuts[i],0,cuts[i+1]-cuts[i],ref.height)
for(const group of ['sleep','peek','drag','walk','emotion']){
  const image=PNG.sync.read(fs.readFileSync(path.join(dir,'source-actions',`${group}-sheet.png`))),w=Math.floor(image.width/2),h=Math.floor(image.height/2)
  const boxes=[0,1,2,3].map(i=>box(image,i%2*w,Math.floor(i/2)*h,w,h))
  const union={x0:Math.min(...boxes.map(b=>b.x0)),y0:Math.min(...boxes.map(b=>b.y0)),x1:Math.max(...boxes.map(b=>b.x1)),y1:Math.max(...boxes.map(b=>b.y1))}
  for(let i=0;i<4;i++){
    const ox=i%2*w,oy=Math.floor(i/2)*h;let pin
    if(group==='drag'){const top=boxes[i].y0;let xs=[];for(let y=top;y<=top+2;y++)for(let x=0;x<w;x++)if(image.data[((oy+y)*image.width+ox+x)*4+3]>160)xs.push(x);pin={x:xs.reduce((a,b)=>a+b,0)/Math.max(1,xs.length),y:top}}
    const name=group==='emotion'?['happy','angry','sad','neutral'][i]:`${({sleep:'sleep-curl',peek:'peek',drag:'drag-lift',walk:'walk'})[group]}_${i}`
    pack(name,image,ox,oy,w,h,union,pin)
  }
}
const columns=6,rows=Math.ceil(frames.length/columns),sheet=new PNG({width:columns*frameW,height:rows*frameH}),atlas={meta:{image:'spritesheet.png',size:{w:sheet.width,h:sheet.height},frameSize:{w:frameW,h:frameH}},frames:{}}
frames.forEach(({name,tile,extra},i)=>{const x=i%columns*frameW,y=Math.floor(i/columns)*frameH;PNG.bitblt(tile,sheet,0,0,frameW,frameH,x,y);atlas.frames[name]={x,y,w:frameW,h:frameH,...extra}})
const clip=(prefix,fps=4)=>({frames:[0,1,2,3].map(i=>`${prefix}_${i}`),fps,loop:true})
const simple=(frame,extra={})=>({loop:true,clips:[{frames:[frame],fps:1,loop:true}],...extra})
const sleep={action:'sleep-curl',loop:true,clips:[clip('sleep-curl',1.1)]}
const drag={action:'drag-lift',loop:true,clips:[clip('drag-lift',2)]}
const states={default:'idle',drag:'drag-lift',talk:'talk',states:{
  idle:simple('front',{action:'idle'}),front:simple('front',{action:'idle'}),side:simple('side',{action:'idle'}),back:simple('back',{action:'idle'}),
  walk:{action:'walk',loop:true,clips:[clip('walk',5)]},'sleep-curl':sleep,sleep,
  'peek-left':{action:'peek-left',loop:true,clips:[{frames:['peek_0','peek_0','peek_0','peek_1','peek_2','peek_3'],fps:1.3,loop:true}]},
  'peek-right':{action:'peek-right',mirror:true,loop:true,clips:[{frames:['peek_0','peek_0','peek_0','peek_1','peek_2','peek_3'],fps:1.3,loop:true}]},
  'drag-lift':drag,drag,talk:simple('front',{action:'idle',motion:{preset:'bounce',periodMs:700,strength:.25}}),
  wave:simple('happy',{action:'idle',emotion:'happy',motion:{preset:'sway',periodMs:1200}}),
  happy:simple('happy',{action:'idle',emotion:'happy'}),angry:simple('angry',{action:'idle',emotion:'angry'}),sad:simple('sad',{action:'idle',emotion:'sad'}),neutral:simple('neutral',{action:'idle',emotion:'neutral'}),
  purr:simple('happy',{action:'idle',emotion:'happy',motion:{preset:'sway',periodMs:2400,strength:.3}})
}}
fs.writeFileSync(path.join(dir,'spritesheet.png'),PNG.sync.write(sheet));fs.writeFileSync(path.join(dir,'atlas.json'),JSON.stringify(atlas,null,2));fs.writeFileSync(path.join(dir,'states.json'),JSON.stringify(states,null,2))
const manifest=JSON.parse(fs.readFileSync(path.join(dir,'plugin.json'),'utf8'));manifest.scale=.4;manifest.version='0.2.0';manifest.description='蓝鲸完整动作包：移动、蜷缩睡眠、左右窥探、提衣领悬垂及喜怒哀乐，接入统一动作调度。';manifest.provides.states=Object.keys(states.states)
fs.writeFileSync(path.join(dir,'plugin.json'),JSON.stringify(manifest,null,2));console.log(`Runtime actions: ${frames.length} frames, ${sheet.width}×${sheet.height}`)
