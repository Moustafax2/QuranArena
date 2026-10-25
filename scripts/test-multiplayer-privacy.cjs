const assert = require('node:assert/strict');
const Module = require('node:module');
require('tsx/cjs');
const { NextRequest } = require('next/server');
const roomId='11111111-1111-4111-8111-111111111111', gameId='22222222-2222-4222-8222-222222222222';
let member=true, identity='owner', broken=false;
const tables={
 rooms:[{id:roomId,code:'ABC123',host_id:'owner',status:'in_progress',game_mode:'multiple-choice',settings:{},created_at:'today'}],
 games:[{id:gameId,room_id:roomId,total_rounds:3,ended_at:null,winner_id:null}],
 room_players:[{room_id:roomId,player_id:'owner',status:'active',score:10,players:{display_name:'Owner'}},{room_id:roomId,player_id:'other',status:'active',score:0,players:{display_name:'Other'}}],
 game_rounds:[
  {id:'done',game_id:gameId,round_number:1,started_at:'yesterday',ended_at:'today',correct_verse_key:'1:2',correct_text:'done answer',options:[]},
  {id:'active',game_id:gameId,round_number:2,started_at:'today',ended_at:null,correct_verse_key:'1:3',correct_text:'secret answer',options:[]},
  {id:'future',game_id:gameId,round_number:3,started_at:null,ended_at:null,correct_verse_key:'1:4',correct_text:'future answer',options:[]},
 ],
 round_answers:[{round_id:'done',player_id:'owner',answer_verse_key:'1:2'},{round_id:'done',player_id:'other',answer_verse_key:'1:1'}],
};
function from(table){
 let rows=tables[table];const filters=[];let single=false, max=null;
 const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},not(k,op,v){filters.push(r=>r[k]!==v);return q;},in(k,vs){filters.push(r=>vs.includes(r[k]));return q;},order(){return q;},limit(n){max=n;return q;},maybeSingle(){single=true;return q;},then(resolve,reject){
  let result=rows.filter(r=>filters.every(f=>f(r)));
  if(table==='room_players'&&single&&!member)result=[];
  if(max)result=result.slice(0,max);
  return Promise.resolve({data:single?result[0]??null:result,error:broken?new Error('db offline'):null}).then(resolve,reject);
 }};return q;
}
const original=Module._load;
Module._load=function(request,parent,main){
 if(request==='server-only')return {};
 if(request==='@/lib/supabase/admin')return {createAdminSupabaseClient:()=>({from})};
 if(request==='@/lib/multiplayer/resolve-player')return {resolvePlayerId:async()=>identity};
 return original.call(this,request,parent,main);
};
const {GET}=require('../src/app/api/multiplayer/state/route.ts');Module._load=original;
async function main(){
 const req=query=>new NextRequest('https://app.test/api/multiplayer/state?'+query);
 member=false;
 assert.equal((await GET(req('game='+gameId))).status,403);
 assert.equal((await GET(req('room='+roomId))).status,403);
 identity=null;
 const invite=await (await GET(req('code=ABC123'))).json();
 assert.equal(invite.room.host_id,'');assert.deepEqual(invite.players,[]);assert.equal(invite.game,null);
 member=true;identity='owner';
 const response=await GET(req('game='+gameId));assert.equal(response.status,200);
 const data=await response.json();
 assert.deepEqual(data.rounds.map(r=>r.id),['done','active']);
 assert.equal(data.rounds[0].correct_verse_key,'1:2');
 assert.equal('correct_verse_key' in data.rounds[1],false);
 assert.equal('correct_text' in data.rounds[1],false);
 assert.deepEqual(data.answers.map(a=>a.player_id),['owner']);
 assert.equal((await GET(req('game=not-a-uuid'))).status,400);
 broken=true;assert.equal((await GET(req('game='+gameId))).status,503);
 console.log('Multiplayer privacy tests passed: nonmember denial, invite redaction, future/active answer-key protection, own answers only, fail closed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
