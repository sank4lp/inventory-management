import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleTableRect,horizontalThumb} from '../public/client/table-scroll.js';
test('table controls stay within the viewport and every clipping ancestor',()=>{
 assert.deepEqual(visibleTableRect({left:20,top:-300,right:1200,bottom:1600},[
 {left:0,top:60,right:900,bottom:800},
 {left:100,top:120,right:850,bottom:700},
 {left:120,top:0,right:820,bottom:650}
 ]),{left:120,top:120,right:820,bottom:650});
 const hidden=visibleTableRect({left:20,top:900,right:300,bottom:1200},[{left:0,top:0,right:400,bottom:800}]);
 assert.ok(hidden.bottom<hidden.top);
});
test('horizontal scroll thumb reflects scroll position, content resizing and small tracks',()=>{
 assert.deepEqual(horizontalThumb(400,1600,600,400),{maximum:1200,width:100,left:150});
 assert.equal(horizontalThumb(400,1600,1200,400).left,300);
 assert.equal(horizontalThumb(400,1600,-20,400).left,0);
 assert.equal(horizontalThumb(400,1600,5000,400).left,300);
 assert.deepEqual(horizontalThumb(400,400,0,400),{maximum:0,width:400,left:0});
 assert.equal(horizontalThumb(40,4000,0,20).width,20);
});
