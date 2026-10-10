import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Crop, Minus, MousePointer2, Plus, RotateCcw, RotateCw, SquareDashed, Trash2 } from 'lucide-react';
import type { Annotation, LabelClass, Point, TaskType } from './types';
import { Button, Field, Notice } from './ui';
import { keypointEdges } from './keypointEdges';
import AttributeValues from './AttributeValues';
import TemplateRuleSummary from './TemplateRuleSummary';
import { deletePolygonPoint, insertPolygonPoint, MAX_POLYGON_POINTS } from './polygonEditing';
import { chipTextColor, chipTextWidth } from './canvasChip';

interface Props {mediaUrl:string;width?:number;height?:number;annotations:Annotation[]|null;classes?:LabelClass[];title:string;taskType?:TaskType;keypointNames?:string[];keypointConnections?:unknown;templateSettings?:Record<string,unknown>;purpose?:'truth'|'keyframe'|'asset';maxObjects?:number;onChange?:(annotations:Annotation[])=>void;disabled?:boolean;imageAlt?:string;onImageDimensions?:(size:{width:number;height:number})=>void;onImageReady?:(ready:boolean)=>void;onPendingChange?:(pending:boolean)=>void;
  /** 只标注区域：比例制（0～1），由画布上框选得到；不传这些属性就不显示这个工具。 */
  region?:{left:number;top:number;right:number;bottom:number}|null;onRegionChange?:(region:{left:number;top:number;right:number;bottom:number}|null)=>void}
interface Gesture {start:Point;original:Annotation[];id:string;kind:'draw'|'move'|'resize'|'rotate'|'vertex';handle?:string;index?:number}
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
// 按画布边界收拢位移。对象已经越界（例如手填了负坐标、旋转框的角超出画布）时上下界会颠倒，
// clamp 会直接返回下界把对象瞬移出去；这种情况保持不动比乱跳安全。
const shiftInBounds=(value:number,min:number,max:number,limit:number)=>{const lo=-min,hi=limit-max;return hi<lo?0:clamp(value,lo,hi);};
/**
 * 旋转框（obb）几何。
 *
 * obb 在库里存在两种存储形态：模型推理与 YOLO 导入给的是四角 points，人工绘制给的是 bbox + rotation。
 * 过去画布对这两种形态分别处理——points 形态退化成不可编辑的 polygon，bbox 形态又被显式排除在
 * 缩放手柄之外——于是旋转框既画不出也调不动。这里统一成「四个角点是唯一真值」：
 * 读取时角点优先、缺省才由 bbox+rotation 展开，写回时保持它原本的存储形态。
 */
/** 角点数量：旋转矩形固定四个点，与引擎 Annotations 的校验一致。 */
const OBB_CORNERS=4;
/** 拖拽时的最小边长（像素）：低于此值引擎会以「面积必须大于零」拒绝保存。 */
const OBB_MIN_SIDE=2;
/** 角度归一到 (-180, 180]，与 SVG rotate() 和数值控件的取值域一致。 */
function normalizeAngle(degrees:number):number{
  if(!Number.isFinite(degrees))return 0;
  const wrapped=((degrees+180)%360+360)%360-180;
  return wrapped===-180?180:wrapped;}
/** 未旋转中心框 + 角度 → 角点。公式与引擎 Annotations.obb() 逐项同构，顺序同为左上、右上、右下、左下。 */
function cornersFromFrame(bbox:{x:number;y:number;width:number;height:number},rotation=0):Point[]{
  const cx=bbox.x+bbox.width/2,cy=bbox.y+bbox.height/2,a=normalizeAngle(rotation)*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
  return[{x:-bbox.width/2,y:-bbox.height/2},{x:bbox.width/2,y:-bbox.height/2},{x:bbox.width/2,y:bbox.height/2},{x:-bbox.width/2,y:bbox.height/2}]
    .map(p=>({x:cx+p.x*c-p.y*s,y:cy+p.x*s+p.y*c}));}
const isFinitePoint=(p:Point)=>Number.isFinite(p.x)&&Number.isFinite(p.y);
/** 取四个角点：角点优先，缺省时由 bbox+rotation 展开；不足四个按「没有几何」处理。 */
function obbCorners(a:Annotation):Point[]{
  const points=a.points;
  if(points&&points.length===OBB_CORNERS&&points.every(isFinitePoint))return points.map(p=>({...p}));
  if(a.bbox&&a.bbox.width>0&&a.bbox.height>0)return cornersFromFrame(a.bbox,a.rotation??0);
  return[];}
/** 角点均值即中心：矩形四个顶点关于中心对称。 */
const obbCenter=(corners:Point[]):Point=>({x:corners.reduce((sum,p)=>sum+p.x,0)/corners.length,y:corners.reduce((sum,p)=>sum+p.y,0)/corners.length});
/** 边 0→1 的方向角就是这张旋转框的旋转角（角点顺序固定）。 */
const obbRotation=(corners:Point[]):number=>{const [from,to]=corners;return normalizeAngle(Math.atan2(to.y-from.y,to.x-from.x)*180/Math.PI);};
/** 角点 → 未旋转中心框 + 角度。宽高取两条边长，不取外接框，否则回读会再次变形。 */
function obbFrame(corners:Point[]):{bbox:{x:number;y:number;width:number;height:number};rotation:number}|null{
  if(corners.length!==OBB_CORNERS||!corners.every(isFinitePoint))return null;
  const center=obbCenter(corners);
  const width=Math.hypot(corners[1].x-corners[0].x,corners[1].y-corners[0].y),height=Math.hypot(corners[3].x-corners[0].x,corners[3].y-corners[0].y);
  if(!(width>0)||!(height>0))return null;
  return{bbox:{x:center.x-width/2,y:center.y-height/2,width,height},rotation:obbRotation(corners)};}
/** 绕中心旋转任意角度：形状与边长不变，引擎的相邻边垂直校验仍然成立。 */
function rotateObb(corners:Point[],degrees:number):Point[]{
  if(!corners.length||!Number.isFinite(degrees))return corners;
  const center=obbCenter(corners),a=degrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
  return corners.map(p=>{const dx=p.x-center.x,dy=p.y-center.y;return{x:center.x+dx*c-dy*s,y:center.y+dx*s+dy*c};});}
/** 旋转手柄落点：顶边中点沿外法线外移，给出可抓取的目标而不压在角点上。 */
function obbRotateHandle(corners:Point[],offset:number):Point{
  const top={x:(corners[0].x+corners[1].x)/2,y:(corners[0].y+corners[1].y)/2};
  const dx=corners[1].x-corners[0].x,dy=corners[1].y-corners[0].y,length=Math.hypot(dx,dy)||1;
  // 角点顺序在图像坐标系（y 向下）下为顺时针，边方向 (dx,dy) 的外法线是 (dy,-dx)。
  return{x:top.x+dy/length*offset,y:top.y-dx/length*offset};}
const isObb=(a:Annotation)=>a.type==='obb';
/** 写回并保持原存储形态。points 形态要真正删掉 bbox/rotation，而不是留成 undefined：
 *  那对「points 与 bbox 同时存在」的键会跟着走进 annotation.save，引擎按 points 解析后忽略 bbox，两边数据就此分叉。 */
function applyObb(a:Annotation,corners:Point[]):Annotation{
  const frame=obbFrame(corners);if(!frame)return a;
  if(a.points?.length===OBB_CORNERS){const next={...a,points:corners};delete next.bbox;delete next.rotation;return next;}
  return{...a,bbox:frame.bbox,rotation:frame.rotation};}
function vertices(a:Annotation):Point[]{
  if(isObb(a))return obbCorners(a);
  if(a.points)return a.points;if(!a.bbox)return [];const b=a.bbox;
  return [{x:b.x,y:b.y},{x:b.x+b.width,y:b.y},{x:b.x+b.width,y:b.y+b.height},{x:b.x,y:b.y+b.height}];
}
/** 四个角点对应的缩放手柄，顺序与 obbCorners 一致（左上、右上、右下、左下）。 */
const OBB_RESIZE_HANDLES=['nw','ne','se','sw'] as const;
/** 四条边的中点手柄：单边拉伸，用于只调整长宽而不移动中心（改宽高比例时比拖角点更可控）。 */
const OBB_EDGE_HANDLES=['n','e','s','w'] as const;
export default function QualityCanvas({mediaUrl,width,height,annotations,classes=[],title,taskType='detect',keypointNames=[],keypointConnections,templateSettings,purpose='truth',maxObjects,onChange,disabled,imageAlt,onImageDimensions,onImageReady,onPendingChange,region=null,onRegionChange}:Props){
  const [natural,setNatural]=useState({width:width??1,height:height??1});const [error,setError]=useState(false);const [showNames,setShowNames]=useState(false);
  const [tool,setTool]=useState<'select'|'draw'>('select');const [selected,setSelected]=useState<string|null>(purpose==='truth'?null:annotations?.[0]?.id??null);const [polygon,setPolygon]=useState<Point[]>([]);const [drawing,setDrawing]=useState(false);
  const [vertex,setVertex]=useState<{id:string;index:number}|null>(null);const [inserting,setInserting]=useState(false);
  const [pointTarget,setPointTarget]=useState<number|null>(null);const [preview,setPreview]=useState<Annotation[]|null>(null);const drag=useRef<Gesture|null>(null);const previewValue=useRef<Annotation[]|null>(null);
  const [undoStack,setUndoStack]=useState<Annotation[][]>([]);const [redoStack,setRedoStack]=useState<Annotation[][]>([]);
  // 小目标（例如视频里的手办）在整图视图中很难精确拖框；放大只改变显示层，保存的仍是原图坐标。
  const [zoom,setZoom]=useState(1);
  // 滚轮以光标为中心缩放；中键或空格+左键拖拽平移视野；方向键把选中对象/顶点微调 1px（Shift = 10px）。
  const viewport=useRef<HTMLDivElement|null>(null);const anchor=useRef<{ox:number;oy:number;ratio:number}[]>([]);
  const pan=useRef<{x:number;y:number;left:number;top:number}|null>(null);const space=useRef(false);const hover=useRef(false);
  useEffect(()=>{const el=viewport.current;if(!el)return;
    const onWheel=(event:WheelEvent)=>{if(!event.deltaY)return;event.preventDefault();const bounds=el.getBoundingClientRect(),ox=event.clientX-bounds.left,oy=event.clientY-bounds.top,factor=event.deltaY<0?1.2:1/1.2;
      setZoom(value=>{const next=clamp(Number((value*factor).toFixed(3)),1,4);if(next!==value)anchor.current.push({ox,oy,ratio:next/value});return next;});};
    el.addEventListener('wheel',onWheel,{passive:false});return()=>el.removeEventListener('wheel',onWheel);},[]);
  useEffect(()=>{const onKeyDown=(event:KeyboardEvent)=>{if(event.code==='Space'&&hover.current){space.current=true;event.preventDefault();}},onKeyUp=(event:KeyboardEvent)=>{if(event.code==='Space')space.current=false;};
    window.addEventListener('keydown',onKeyDown);window.addEventListener('keyup',onKeyUp);return()=>{window.removeEventListener('keydown',onKeyDown);window.removeEventListener('keyup',onKeyUp);};},[]);
  // 缩放改变了内容尺寸：按比例换算滚动位置，让光标下的那个点留在原地。
  // 滚轮是连续事件，React 会把同一帧里的多次 setZoom 合并成一次渲染：这里必须把每一步都记下来
  // 依次换算（两次换算等价于「先缩一步再缩一步」），只留最后一次会让锚点在快速缩放时整体漂移。
  useLayoutEffect(()=>{const pending=anchor.current,el=viewport.current;anchor.current=[];if(!el)return;
    for(const step of pending){el.scrollLeft=(el.scrollLeft+step.ox)*step.ratio-step.ox;el.scrollTop=(el.scrollTop+step.oy)*step.ratio-step.oy;}},[zoom]);
  // 只标注区域：整图送模型时小目标框偏松，框一块区域再标能让目标相对变大。区域按比例存，与显示尺寸无关。
  // 拖拽同时记在 ref 上：pointermove 可能赶在 React 重渲染之前到达，读 state 会丢掉这一段位移。
  const [regionTool,setRegionTool]=useState(false);const [regionDraft,setRegionDraft]=useState<{start:Point;current:Point}|null>(null);const regionDraftRef=useRef<{start:Point;current:Point}|null>(null);
  const regionRect=regionDraft
    ?{x:Math.min(regionDraft.start.x,regionDraft.current.x),y:Math.min(regionDraft.start.y,regionDraft.current.y),width:Math.abs(regionDraft.current.x-regionDraft.start.x),height:Math.abs(regionDraft.current.y-regionDraft.start.y),draft:true}
    :region?{x:region.left*(width??natural.width),y:region.top*(height??natural.height),width:(region.right-region.left)*(width??natural.width),height:(region.bottom-region.top)*(height??natural.height),draft:false}:null;
  const list=preview??annotations??[];const current=list.find(a=>a.id===selected);const w=width??natural.width,h=height??natural.height,editable=Boolean(onChange)&&!disabled,scale=Math.max(w/650,1),color='#437fe5';
  // 图片宽高比交给样式表做高度封顶（见 pages.css 的 .asset-annotator .quality-image）：
  // 叠加层 svg 与图片必须共用同一个盒子，只压图片会让坐标换算整体偏移。尺寸未知时给一个
  // 足够大的比例，让 max-width:min(100%,…) 取到 100%，避免容器先塌成 0 宽再跳回来。
  const imageRatio=w>0&&h>0?String(w/h):'999';
  // 同一套画布服务三种用途，控件文案随用途变化：标准答案 / 视频关键帧 / 普通素材的人工标注。
  const objectName=purpose==='keyframe'?'关键帧对象':purpose==='asset'?'标注对象':'标准答案对象';
  useEffect(()=>{onPendingChange?.(drawing||polygon.length>0);},[drawing,polygon.length,onPendingChange]);
  function record(next:Annotation[]){
    if(!editable)return;
    // 空操作不入撤销栈：单击选中对象、拖回原位都不该吃掉一次撤销，更不该清空重做栈。
    if(JSON.stringify(next)===JSON.stringify(annotations??[]))return;
    setUndoStack(stack=>[...stack.slice(-49),structuredClone(annotations??[])]);setRedoStack([]);onChange!(next);
  }
  function undo(){
    if(!editable||!undoStack.length)return;
    const previous=undoStack.at(-1)!;setRedoStack(stack=>[...stack,structuredClone(annotations??[])]);setUndoStack(stack=>stack.slice(0,-1));onChange!(structuredClone(previous));
  }
  function redo(){
    if(!editable||!redoStack.length)return;
    const next=redoStack.at(-1)!;setUndoStack(stack=>[...stack,structuredClone(annotations??[])]);setRedoStack(stack=>stack.slice(0,-1));onChange!(structuredClone(next));
  }
  function position(e:React.PointerEvent<SVGSVGElement>){const bounds=e.currentTarget.getBoundingClientRect();return{x:clamp((e.clientX-bounds.left)/bounds.width*w,0,w),y:clamp((e.clientY-bounds.top)/bounds.height*h,0,h)};}
  function update(change:Partial<Annotation>){if(current&&editable)record(list.map(a=>a.id===current.id?{...a,...change}:a));}
  // 方向键微调：选中顶点时只动顶点，否则整体平移，越界按画布边界收拢（小目标 1px 精修）。
  function nudge(dx:number,dy:number){if(!editable||!current)return;
    if(vertex?.id===current.id&&current.points){update({points:current.points.map((pt,i)=>i===vertex.index?{x:clamp(pt.x+dx,0,w),y:clamp(pt.y+dy,0,h)}:pt)});return;}
    const parts=[...vertices(current),...(current.keypoints??[]).filter(k=>k.visibility>0)];
    const tx=parts.length?shiftInBounds(dx,Math.min(...parts.map(p=>p.x)),Math.max(...parts.map(p=>p.x)),w):0,ty=parts.length?shiftInBounds(dy,Math.min(...parts.map(p=>p.y)),Math.max(...parts.map(p=>p.y)),h):0;if(!tx&&!ty)return;
    update({...(current.bbox?{bbox:{...current.bbox,x:current.bbox.x+tx,y:current.bbox.y+ty}}:{}),...(current.points?{points:current.points.map(pt=>({x:pt.x+tx,y:pt.y+ty}))}:{}),...(current.keypoints?{keypoints:current.keypoints.map(k=>k.visibility>0?{...k,x:k.x+tx,y:k.y+ty}:k)}:{})});}
  function finishPolygon(){if(!editable||polygon.length<3||polygon.length>MAX_POLYGON_POINTS)return;const shape:Annotation={id:crypto.randomUUID(),classId:classes[0]?.id??'',type:'segment',points:polygon};record([...(annotations??[]),shape]);setSelected(shape.id);setPolygon([]);setTool('select');}
  function deleteVertex(){if(!editable||drag.current||polygon.length||vertex?.id!==current?.id||!current?.points||vertex===null)return;const points=deletePolygonPoint(current.points,vertex.index);if(points){update({points});setVertex(null);}}
  function down(e:React.PointerEvent<SVGSVGElement>){
    // 中键或空格+左键拖拽平移（放大后挪视野），与画笔/选择手势互斥。
    if(e.button===1||space.current&&e.button===0){const el=viewport.current;if(!el)return;e.preventDefault();pan.current={x:e.clientX,y:e.clientY,left:el.scrollLeft,top:el.scrollTop};try{e.currentTarget.setPointerCapture(e.pointerId);}catch{/* 合成事件没有真实指针 */}return;}
    if(!editable||error||e.button!==0||taskType==='classify')return;const start=position(e);e.currentTarget.focus();
    // 区域工具独占一次拖拽：它不改标注，只框出「只标注这块」的范围。
    if(regionTool&&onRegionChange){const draft={start,current:start};regionDraftRef.current=draft;setRegionDraft(draft);try{e.currentTarget.setPointerCapture(e.pointerId);}catch{/* 合成事件没有真实指针，拖拽仍按指针事件走 */}return;}
    if(pointTarget!==null&&current?.keypoints){update({keypoints:current.keypoints.map((p,i)=>i===pointTarget?{...p,...start,visibility:2}:p)});setPointTarget(null);return;}
    if(tool==='draw'&&maxObjects!==undefined&&list.length>=maxObjects)return;
    if(tool==='draw'&&taskType==='segment'){if(polygon.length<MAX_POLYGON_POINTS)setPolygon(points=>[...points,start]);return;}
    const edge=(e.target as SVGElement).getAttribute('data-quality-edge');if(inserting&&current?.type==='segment'&&current.points&&edge!==null){const points=insertPolygonPoint(current.points,Number(edge),start);if(points){update({points});setVertex({id:current.id,index:Number(edge)+1});setInserting(false);}return;}
    const target=(e.target as SVGElement).closest('[data-quality-object]');const id=tool==='draw'?crypto.randomUUID():target?.getAttribute('data-quality-object');if(!id){setSelected(null);setVertex(null);setInserting(false);return;}
    const handle=(e.target as SVGElement).getAttribute('data-quality-handle')??undefined,vertex=(e.target as SVGElement).getAttribute('data-quality-vertex');setSelected(id);setVertex(vertex!==null&&list.find(a=>a.id===id)?.type==='segment'?{id,index:Number(vertex)}:null);if(id!==selected)setInserting(false);e.currentTarget.setPointerCapture(e.pointerId);setDrawing(true);
    // data-quality-handle="rotate" 是旋转框专属的旋转手柄：它不改变宽高，只改标架角度，
    // 因此单独识别成 rotate 手势，不能混进 resize（resize 分支按 bbox 的边推算尺寸）。
    drag.current={start,original:structuredClone(annotations??[]),id,kind:tool==='draw'?'draw':vertex!==null?'vertex':handle==='rotate'?'rotate':handle?'resize':'move',handle,index:vertex!==null?Number(vertex):undefined};
  }
  function move(e:React.PointerEvent<SVGSVGElement>){
    const panning=pan.current;
    if(panning){const el=viewport.current;if(el){el.scrollLeft=panning.left-(e.clientX-panning.x);el.scrollTop=panning.top-(e.clientY-panning.y);}return;}
    const draft=regionDraftRef.current;
    if(draft){const next={...draft,current:position(e)};regionDraftRef.current=next;setRegionDraft(next);return;}
    const state=drag.current;if(!state)return;const p=position(e);let next=structuredClone(state.original);
    if(state.kind==='draw')next.push({id:state.id,classId:classes[0]?.id??'',type:taskType,bbox:{x:Math.min(state.start.x,p.x),y:Math.min(state.start.y,p.y),width:Math.abs(p.x-state.start.x),height:Math.abs(p.y-state.start.y)},...(taskType==='pose'?{keypoints:keypointNames.map(name=>({name,x:0,y:0,visibility:0 as const}))}:{})});
    else next=next.map(a=>{
      if(a.id!==state.id)return a;if(state.kind==='vertex'&&a.points)return {...a,points:a.points.map((pt,i)=>i===state.index?p:pt)};
      // 旋转框的几何以四个角点为唯一真值，拖动过程中不落回 bbox：
      // 角点一旦经过一次「角点↔中心框」的往返，引擎那边的矩形校验就可能因舍入而拒绝保存。
      if(isObb(a)&&(state.kind==='rotate'||state.kind==='resize')){
        const corners=obbCorners(a);if(corners.length!==4)return a;
        if(state.kind==='rotate'){
          const c=obbCenter(corners);
          return applyObb(a,rotateObb(corners,normalizeAngle((Math.atan2(p.y-c.y,p.x-c.x)*180)/Math.PI-obbRotation(corners))));
        }
        // 缩放：角点手柄以中心对称缩放（中心不动），边中点手柄单边拉伸（对边固定）。
        const f=obbFrame(corners);if(!f)return a;
        const center=obbCenter(corners),halfW=f.bbox.width/2,halfH=f.bbox.height/2;
        // 把指针逆旋转回未旋转的局部坐标，才能沿框自身的边判断要改哪一侧。
        const rad=-obbRotation(corners)*Math.PI/180,cos=Math.cos(rad),sin=Math.sin(rad);
        const dx=p.x-center.x,dy=p.y-center.y,lx=dx*cos-dy*sin,ly=dx*sin+dy*cos;
        const g=state.handle??'',horizontal=g.includes('w')||g.includes('e'),vertical=g.includes('n')||g.includes('s');
        let width=f.bbox.width,height=f.bbox.height,ox=0,oy=0;
        if(horizontal){const edge=g.includes('w')?-halfW+lx:halfW+lx;
          if(horizontal&&vertical){width=Math.abs(lx)*2;}else{const fixed=g.includes('w')?halfW:-halfW;width=Math.max(Math.abs(edge-fixed),OBB_MIN_SIDE);ox=(edge+fixed)/2;}}
        if(vertical){const edge=g.includes('n')?-halfH+ly:halfH+ly;
          if(horizontal&&vertical){height=Math.abs(ly)*2;}else{const fixed=g.includes('n')?halfH:-halfH;height=Math.max(Math.abs(edge-fixed),OBB_MIN_SIDE);oy=(edge+fixed)/2;}}
        // 局部中心偏移旋回画布坐标：对称缩放时偏移为 0，中心保持不动。
        const nc={x:center.x+ox*cos+oy*sin,y:center.y-ox*sin+oy*cos};
        // 角点顺序固定为左上、右上、右下、左下，与 obbCorners 及引擎的角点顺序一致。
        const corner=(sx:number,sy:number)=>({x:nc.x+sx*width/2*cos+sy*height/2*sin,y:nc.y-sx*width/2*sin+sy*height/2*cos});
        return applyObb(a,[corner(-1,-1),corner(1,-1),corner(1,1),corner(-1,1)]);
      }
      const b=a.bbox;if(state.kind==='resize'&&b){const x=state.handle?.includes('w')?Math.min(p.x,b.x+b.width-1):b.x,y=state.handle?.includes('n')?Math.min(p.y,b.y+b.height-1):b.y;return{...a,bbox:{x,y,width:(state.handle?.includes('e')?Math.max(p.x,x+1):b.x+b.width)-x,height:(state.handle?.includes('s')?Math.max(p.y,y+1):b.y+b.height)-y}};}
      const points=[...vertices(a),...(a.keypoints??[]).filter(k=>k.visibility>0)];if(!points.length)return a;const dx=shiftInBounds(p.x-state.start.x,Math.min(...points.map(v=>v.x)),Math.max(...points.map(v=>v.x)),w),dy=shiftInBounds(p.y-state.start.y,Math.min(...points.map(v=>v.y)),Math.max(...points.map(v=>v.y)),h);
      return {...a,...(b?{bbox:{...b,x:b.x+dx,y:b.y+dy}}:{}),...(a.points?{points:a.points.map(pt=>({x:pt.x+dx,y:pt.y+dy}))}:{}),...(a.keypoints?{keypoints:a.keypoints.map(k=>k.visibility>0?{...k,x:k.x+dx,y:k.y+dy}:k)}:{})};
    });previewValue.current=next;setPreview(next);
  }
  function up(event:React.PointerEvent<SVGSVGElement>){
    if(pan.current){pan.current=null;return;}
    // 区域拖拽收尾：太小的区域直接丢弃（引擎也会拒绝退化区域），其余按比例交给上层保存。
    const draft=regionDraftRef.current;
    if(draft){const p=position(event),x=Math.min(draft.start.x,p.x),y=Math.min(draft.start.y,p.y),rectW=Math.abs(p.x-draft.start.x),rectH=Math.abs(p.y-draft.start.y);regionDraftRef.current=null;setRegionDraft(null);setRegionTool(false);
      if(onRegionChange&&rectW>=w*0.02&&rectH>=h*0.02)onRegionChange({left:x/w,top:y/h,right:(x+rectW)/w,bottom:(y+rectH)/h});return;}
    const state=drag.current;if(state)move(event);drag.current=null;setDrawing(false);if(state&&previewValue.current){
      // 「小于 2px 就丢弃」只针对刚拖出来的框；套用到已有对象上，会让 1px 的对象在单击或缩放收尾时被静默删掉。
      const next=state.kind==='draw'?previewValue.current.filter(a=>a.id!==state.id||!a.bbox||(a.bbox.width>=2&&a.bbox.height>=2)):previewValue.current;
      record(next);setTool('select');}previewValue.current=null;setPreview(null);}
  return <div className={`quality-canvas ${onChange?'editable':''}`}><div className="quality-canvas-heading"><strong>{title}</strong><div className="quality-canvas-tools">{list.some(a=>a.keypoints?.length)&&<label className="checkbox-row"><input type="checkbox" checked={showNames} onChange={e=>setShowNames(e.target.checked)}/>显示点名</label>}<div className="zoom-controls" role="group" aria-label="画布缩放"><Button aria-label="缩小画布" title="缩小画布" disabled={zoom<=1} onClick={()=>setZoom(value=>Math.max(1,Number((value-.25).toFixed(2))))}><Minus size={13}/></Button><span aria-live="polite">{Math.round(zoom*100)}%</span><Button aria-label="放大画布" title="放大画布" disabled={zoom>=4} onClick={()=>setZoom(value=>Math.min(4,Number((value+.25).toFixed(2))))}><Plus size={13}/></Button><Button aria-label="复位画布缩放" title="复位画布缩放" disabled={zoom===1} onClick={()=>setZoom(1)}><RotateCcw size={12}/></Button></div>{onRegionChange&&<div className="region-controls" role="group" aria-label="只标注区域"><Button aria-label="只标注这块区域" title="拖出一块只标注它的区域；坐标会自动换算回整图" aria-pressed={regionTool} disabled={!editable} onClick={()=>{setRegionTool(value=>!value);setTool('select');}}><Crop size={13}/>{regionTool?'拖出区域…':'只标注这块区域'}</Button>{region&&<Button aria-label="清除标注区域" title="清除标注区域，恢复整图标注" disabled={!editable} onClick={()=>onRegionChange(null)}>清除区域</Button>}</div>}</div>{onChange&&<div className="actions">{taskType!=='classify'&&<><Button disabled={!editable||polygon.length>0} aria-pressed={tool==='select'} onClick={()=>{setTool('select');setPointTarget(null);}}><MousePointer2 size={13}/>选择</Button><Button disabled={!editable||polygon.length>0||maxObjects!==undefined&&list.length>=maxObjects} aria-pressed={tool==='draw'} onClick={()=>{setTool('draw');setPointTarget(null);}}><SquareDashed size={13}/>{taskType==='segment'?'绘制标准多边形':taskType==='obb'?'绘制标准旋转框':purpose==='keyframe'?'绘制对象框':purpose==='asset'?'绘制标注框':'绘制标准框'}</Button></>}<Button aria-label="撤销标注改动" title="撤销（Ctrl+Z）" disabled={!editable||!undoStack.length} onClick={undo}><RotateCcw size={13}/>撤销</Button><Button aria-label="重做标注改动" title="重做（Ctrl+Shift+Z）" disabled={!editable||!redoStack.length} onClick={redo}><RotateCw size={13}/>重做</Button></div>}</div>
    <div className="quality-canvas-columns"><div><div className="quality-image" ref={viewport} style={{'--image-ratio':imageRatio} as CSSProperties} onPointerEnter={()=>hover.current=true} onPointerLeave={()=>{hover.current=false;space.current=false;}}><div className="quality-image-stage" style={{width:`${zoom*100}%`}}><img src={mediaUrl} alt={imageAlt??(purpose==='keyframe'?'视频关键帧原图':purpose==='asset'?'素材原图':'评测样本原图')} onLoad={e=>{setNatural({width:e.currentTarget.naturalWidth,height:e.currentTarget.naturalHeight});onImageDimensions?.({width:e.currentTarget.naturalWidth,height:e.currentTarget.naturalHeight});setError(false);onImageReady?.(true);}} onError={()=>{setError(true);onImageReady?.(false);}}/>{!error&&<svg aria-label={onChange?purpose==='keyframe'?'关键帧标注画布':purpose==='asset'?'素材标注画布':'独立标准答案画布':title} tabIndex={onChange?0:undefined} viewBox={`0 0 ${w} ${h}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={()=>{drag.current=null;pan.current=null;previewValue.current=null;setPreview(null);setDrawing(false);}} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();if(polygon.length&&!e.shiftKey)setPolygon(points=>points.slice(0,-1));else if(e.shiftKey)redo();else undo();return;}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();redo();return;}const step={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(step&&editable&&current){e.preventDefault();nudge(step[0]*(e.shiftKey?10:1),step[1]*(e.shiftKey?10:1));return;}if(e.key==='Enter'&&polygon.length){e.preventDefault();finishPolygon();}if(e.key==='Escape'){setPolygon([]);setPointTarget(null);setVertex(null);setInserting(false);setTool('select');}if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();e.stopPropagation();deleteVertex();}}}>
      {list.map(a=>{const obb=isObb(a),corners=obb?obbCorners(a):[],b=obb?null:a.bbox,c=classes.find(c=>c.id===a.classId),stroke=c?.color??color,points=vertices(a),anchor=points.length?{x:Math.min(...points.map(p=>p.x)),y:Math.min(...points.map(p=>p.y))}:null;return <g key={a.id} data-quality-object={a.id} data-selected={selected===a.id ? 'true' : undefined}>
        {/* 旋转框统一按四个角点绘制，并给出四角缩放手柄、边中点手柄与圆形旋转手柄。
            此前 obb 被显式排除在缩放手柄之外，且 points 形态（模型产出）退化成不可编辑的 polygon，
            结果是「画不出也调不动旋转框」。 */}
        {corners.length===4&&(()=>{
          // 边中点取相邻两角的中点，旋转手柄沿顶边外法线外移，两者都自动跟随框的旋转。
          const midpoints=[0,1,2,3].map(i=>({x:(corners[i].x+corners[(i+1)%4].x)/2,y:(corners[i].y+corners[(i+1)%4].y)/2}));
          const top=midpoints[0],grip=obbRotateHandle(corners,24*scale);
          return <g data-quality-obb={a.id}><polygon points={corners.map(p=>`${p.x},${p.y}`).join(' ')} stroke={stroke} fill={onChange&&selected===a.id?'#437fe51a':'transparent'} strokeWidth={2*scale}/>
            {editable&&selected===a.id&&<>
              {corners.map((p,i)=><circle key={`obb-c-${i}`} data-quality-handle={OBB_RESIZE_HANDLES[i]} cx={p.x} cy={p.y} r={4.5*scale} fill="white" stroke={stroke} strokeWidth={1.5*scale}/>)}
              {midpoints.map((p,i)=><rect key={`obb-e-${i}`} data-quality-handle={OBB_EDGE_HANDLES[i]} x={p.x-3.5*scale} y={p.y-3.5*scale} width={7*scale} height={7*scale} rx={1.5*scale} fill={stroke} stroke="white" strokeWidth={1.2*scale}/>)}
              <g data-quality-rotate-handle={a.id}><line x1={top.x} y1={top.y} x2={grip.x} y2={grip.y} stroke={stroke} strokeWidth={1.5*scale}/><circle data-quality-handle="rotate" cx={grip.x} cy={grip.y} r={5.5*scale} fill={stroke} stroke="white" strokeWidth={1.5*scale}/></g>
            </>}</g>;})()}
        {!obb&&b&&<g><rect x={b.x} y={b.y} width={b.width} height={b.height} stroke={stroke} fill={onChange&&selected===a.id?'#437fe51a':'transparent'} strokeWidth={2*scale}/>{editable&&selected===a.id&&[['nw',b.x,b.y],['ne',b.x+b.width,b.y],['sw',b.x,b.y+b.height],['se',b.x+b.width,b.y+b.height]].map(([handle,x,y])=><rect key={handle} data-quality-handle={handle} x={Number(x)-4*scale} y={Number(y)-4*scale} width={8*scale} height={8*scale} fill="white" stroke={stroke}/>)}</g>}
        {!obb&&a.points&&<><polygon points={a.points.map(p=>`${p.x},${p.y}`).join(' ')} stroke={stroke} fill={`${stroke}18`} strokeWidth={2*scale}/>{editable&&selected===a.id&&a.type==='segment'&&<>{inserting&&a.points.map((p,i)=><line key={`edge-${i}`} data-quality-edge={i} x1={p.x} y1={p.y} x2={a.points![(i+1)%a.points!.length].x} y2={a.points![(i+1)%a.points!.length].y} stroke="transparent" strokeWidth={14*scale} className="segment-insert-edge"/>)}{a.points.map((p,i)=><circle key={i} data-quality-vertex={i} cx={p.x} cy={p.y} r={4*scale} fill={vertex?.id===a.id&&vertex.index===i?stroke:'white'} stroke={stroke}/>)}</>}</>}
        {anchor&&(()=>{const name=c?.name??a.classId,labelWidth=chipTextWidth(name,11.5*scale)+10*scale,labelX=clamp(anchor.x,2*scale,Math.max(2*scale,w-labelWidth-2*scale)),aboveY=anchor.y-19*scale,labelY=aboveY>=2*scale?aboveY:anchor.y+3*scale;return<g data-quality-label><rect x={labelX} y={labelY} width={labelWidth} height={17*scale} rx={3.5*scale} fill={stroke}/><text x={labelX+5*scale} y={labelY+12.5*scale} fill={chipTextColor(stroke)} fontSize={11.5*scale} fontWeight={600}>{name}</text></g>;})()}
        {a.type==='classify'&&(()=>{const name=c?.name??a.classId,chipWidth=Math.min(w-20*scale,Math.max(110*scale,chipTextWidth(name,14*scale)+16*scale));return<g><rect x={10*scale} y={10*scale} width={chipWidth} height={30*scale} rx={4*scale} fill={stroke}/><text x={18*scale} y={30*scale} fill={chipTextColor(stroke)} fontSize={14*scale} fontWeight={600}>{name}</text></g>;})()}
        {keypointEdges(a.keypoints,keypointConnections).map(([from,to],edge)=><line key={edge} data-keypoint-edge x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={stroke} strokeWidth={1.5*scale}/>)}
      {a.keypoints?.filter(p=>p.visibility>0).map(p=><g key={p.name}><circle cx={p.x} cy={p.y} r={4*scale} fill={p.visibility===2?stroke:'white'} stroke={stroke} strokeWidth={1.5*scale}/>{showNames&&<text x={p.x+6*scale} y={p.y-6*scale} fill={stroke} fontSize={10*scale} paintOrder="stroke" stroke="white" strokeWidth={2*scale}>{p.name}</text>}</g>)}
      </g>;})}{regionRect&&<rect data-quality-region={regionRect.draft?'draft':'saved'} pointerEvents="none" x={regionRect.x} y={regionRect.y} width={regionRect.width} height={regionRect.height} fill="#f59e0b14" stroke="#f59e0b" strokeWidth={2*scale} strokeDasharray={`${6*scale} ${4*scale}`}/>}{polygon.length>0&&<polyline points={polygon.map(p=>`${p.x},${p.y}`).join(' ')} stroke={color} fill={`${color}18`} strokeWidth={2*scale}/>}</svg>}</div></div>
      {error&&<p className="inline-error">此来源的样本图片无法读取，未替换为其他图片。</p>}{annotations===null&&<Notice>此样本没有可用候选，不能按“成功但无目标”解释。</Notice>}{annotations?.length===0&&taskType==='classify'&&!onChange&&<p className="muted">模型成功返回，但没有分类结果。</p>}
      {onChange&&<p className="muted tiny">{inserting?'点击选中多边形的边插入顶点。':vertex?.id===current?.id&&vertex?`选中顶点 ${vertex.index+1}，Delete 删点；删除对象使用独立按钮。`:pointTarget!==null?`点击图片定位关键点：${current?.keypoints?.[pointTarget]?.name}`:taskType==='classify'?'在右侧明确选择一个人工标准类别。':tool==='draw'?taskType==='segment'?'逐点点击边界，至少三个点后完成多边形。':taskType==='pose'?'拖动绘制对象框；关键点初始为不可定位，需人工逐点设置。':taskType==='obb'?'拖动绘制旋转框；选中后拖角点改尺寸、拖边中点改单边长宽、拖顶部圆点旋转，也可在右侧直接填角度。':purpose==='keyframe'?'拖动绘制对象框。':purpose==='asset'?'拖动绘制标注框。':'拖动绘制标准对象框。':'点击对象选择，可拖动或调整几何参数。'}</p>}
      {polygon.length>0&&<div className="actions"><Button disabled={!editable||polygon.length<3} onClick={finishPolygon}>完成标准多边形</Button><Button disabled={!editable} onClick={()=>setPolygon(p=>p.slice(0,-1))}>撤销最后一点</Button><Button disabled={!editable} onClick={()=>{setPolygon([]);setTool('select');}}>取消当前多边形</Button></div>}
    </div>{onChange&&<aside className="truth-properties">{taskType==='classify'?<Field label="人工标准类别" hint="每张图片必须明确选择一个类别。"><select aria-label="人工标准分类" value={list[0]?.classId??''} disabled={!editable} onChange={e=>{if(e.target.value)record([{...list[0],id:list[0]?.id??crypto.randomUUID(),classId:e.target.value,type:'classify'}]);}}><option value="">尚未选择</option>{classes.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>:<>
      {list.length>0&&<Field label={objectName}><select value={selected??''} disabled={!editable} onChange={e=>{setSelected(e.target.value);setPointTarget(null);setVertex(null);setInserting(false);}}><option value="">选择对象</option>{list.map((a,i)=><option key={a.id} value={a.id}>{i+1} · {classes.find(c=>c.id===a.classId)?.name??a.classId}</option>)}</select></Field>}
      {current?<><Field label={purpose==='keyframe'?'对象类别':purpose==='asset'?'标注类别':'标准答案类别'}><select value={current.classId} disabled={!editable} onChange={e=>update({classId:e.target.value})}>{classes.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>{(()=>{
      // 旋转框的几何值从角点反解，points 形态没有 bbox，直接读 bbox 会让控件空着或写坏数据。
      const corners=isObb(current)?obbCorners(current):[],frame=corners.length===4?obbFrame(corners):null;
      const box=frame?frame.bbox:current.bbox;if(!box)return null;
      const setBox=(next:{x:number;y:number;width:number;height:number})=>{
        if(frame){
          // 数值控件给的是「未旋转中心框」，因此按新尺寸重建角点，再平移到控件所指的中心。
          const center={x:next.x+next.width/2,y:next.y+next.height/2};
          const rebuilt=cornersFromFrame({x:-next.width/2,y:-next.height/2,width:next.width,height:next.height},frame.rotation)
            .map(v=>({x:v.x+center.x,y:v.y+center.y}));
          update(applyObb(current,rebuilt));}
        else update({bbox:next});};
      return <div className="geometry-fields">{(['x','y','width','height'] as const).map((key,i)=><Field key={key} label={['X','Y','宽度','高度'][i]}><input aria-label={`${objectName}${key}`} type="number" value={Math.round(box[key]*100)/100} disabled={!editable} onChange={e=>{const n=Number(e.target.value);if(!Number.isFinite(n))return;
        const next={...box,[key]:n};if(key==='width'||key==='height'){next[key]=Math.max(n,OBB_MIN_SIDE);}
        setBox(next);}}/></Field>)}</div>;})()}
      {current.type==='obb'&&<Field label="标准旋转角度" hint="也可以直接拖动画布上的圆形旋转手柄。"><input aria-label="标准旋转角度" type="number" min={-180} max={180} step={1} disabled={!editable} value={(()=>{const corners=obbCorners(current);return corners.length===4?Math.round(obbRotation(corners)*100)/100:0;})()} onChange={e=>{const value=Number(e.target.value);if(!Number.isFinite(value))return;const corners=obbCorners(current);if(corners.length===4)update(applyObb(current,rotateObb(corners,value-obbRotation(corners))));}}/></Field>}
      <AttributeValues definition={templateSettings?.attributes} value={current.attributes} onChange={attributes=>update({attributes})} disabled={!editable}/>
      {current.type==='segment'&&current.points&&<div className="segment-controls"><div className="actions"><Button type="button" disabled={!editable||current.points.length>=MAX_POLYGON_POINTS} aria-pressed={inserting} onClick={()=>{setInserting(v=>!v);setVertex(null);setTool('select');}}>在边上插点</Button><Button type="button" disabled={!editable||vertex?.id!==current.id||current.points.length<=3} onClick={deleteVertex}>删除选中顶点</Button></div><small>3–4096 个顶点；选中点后 Delete 删点。</small></div>}
      {current.type==='segment'&&current.points?.map((point,i)=><div className="truth-point" key={i}><button type="button" className="text-button" aria-label={`选择标准顶点${i+1}`} aria-pressed={vertex?.id===current.id&&vertex.index===i} onClick={e=>{setVertex({id:current.id,index:i});setInserting(false);setTool('select');e.currentTarget.closest('.quality-canvas')?.querySelector('svg')?.focus();}}>边界点 {i+1}</button><div className="point-row">{(['x','y'] as const).map(key=><input aria-label={`标准边界点${i+1}${key}`} key={key} type="number" disabled={!editable} value={Math.round(point[key]*100)/100} onChange={e=>update({points:current.points!.map((p,j)=>j===i?{...p,[key]:Number(e.target.value)}:p)})}/>)}</div></div>)}
      {current.keypoints?.map((point,i)=><div className="truth-point" key={point.name}><strong>{point.name}</strong><select aria-label={`${point.name}${purpose==='keyframe'?'':'标准'}可见性`} value={point.visibility} disabled={!editable} onChange={e=>update({keypoints:current.keypoints!.map((p,j)=>j===i?{...p,visibility:Number(e.target.value) as 0|1|2}:p)})}><option value={0}>不可定位</option><option value={1}>遮挡，可定位</option><option value={2}>可见</option></select><small>{point.visibility>0?`${Math.round(point.x)}, ${Math.round(point.y)}`:'位置不计入误差'}</small><Button disabled={!editable} onClick={()=>setPointTarget(i)}>在图上定位</Button></div>)}<Button disabled={!editable} onClick={()=>{record(list.filter(a=>a.id!==current.id));setSelected(null);setVertex(null);setInserting(false);}}><Trash2 size={13}/>{`删除${objectName}`}</Button></>:<p className="muted">{`绘制或选择一个${objectName}。`}</p>}
    </>}{taskType==='classify'&&list[0]&&<AttributeValues definition={templateSettings?.attributes} value={list[0].attributes} disabled={!editable} onChange={attributes=>record([{...list[0],attributes}])}/>}</aside>}</div><TemplateRuleSummary settings={templateSettings}/>{!onChange&&templateSettings?.attributes!==undefined&&<details className="fixed-attribute-values"><summary>固定对象属性</summary>{list.map((a,i)=><section key={a.id}><strong>对象 {i+1}</strong><AttributeValues definition={templateSettings.attributes} value={a.attributes}/></section>)}</details>}</div>;
}
