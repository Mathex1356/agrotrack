import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { SignJWT } from 'jose';
import { loadEnvironment } from '../dist/config/environment.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { AuthService } from '../dist/auth/auth.service.js';
import { AuthGuard } from '../dist/auth/auth.guard.js';
import { AuthConfig } from '../dist/auth/auth.config.js';
import { PasswordService } from '../dist/auth/password.service.js';
import { AuthorizationService } from '../dist/authorization/authorization.service.js';
import { PermissionGuard } from '../dist/authorization/permission.guard.js';
import { FieldsController } from '../dist/fields/fields.controller.js';
import { FieldsService } from '../dist/fields/fields.service.js';
import { FarmsController } from '../dist/farms/farms.controller.js';
import { FarmsService } from '../dist/farms/farms.service.js';
import { configureHttp } from '../dist/http-security.js';
import { provisionSystemRoles } from '../prisma/permissions.mjs';

let db, config;
const rollback = new Error('Rollback field fixtures');
const polygon = (x = -50, y = -20, size = 0.001) => ({ type: 'Polygon', coordinates: [[[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]]] });
const input = { code: 'NEW', name: 'Field', areaHa: '20' };
before(async () => {
  loadEnvironment(); process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = randomBytes(32).toString('base64url');
  process.env.AUTH_RATE_LIMIT_SECRET = randomBytes(32).toString('base64url');
  process.env.AUTH_ALLOWED_ORIGINS = 'http://localhost:5173';
  config = new AuthConfig(); db = new PrismaService(); await db.onModuleInit();
});
after(async () => { await db?.$disconnect(); });
async function fixtures(tx, custom = false) {
  const userId = randomUUID(), otherId = randomUUID(), aId = randomUUID(), bId = randomUUID();
  for (const id of [userId, otherId]) await tx.user.create({ data: { id, displayName: 'Field test', email: `${id}@example.test`, normalizedEmail: `${id}@example.test` } });
  for (const id of [aId,bId]) await tx.organization.create({ data: { id, name: 'Field test', referenceCode: id.toUpperCase(), status: 'ACTIVE' } });
  let roles;
  if (custom) {
    const role = await tx.role.create({ data: { organizationId: aId, name: 'Concurrent field test' } });
    roles = { OWNER: role };
    await tx.rolePermission.createMany({ data: ['farms.read','farms.manage','fields.manage'].map(permissionCode => ({ organizationId: aId, roleId: role.id, permissionCode })) });
  } else {
    await provisionSystemRoles(tx, aId);
    roles = Object.fromEntries((await tx.role.findMany({ where: { organizationId: aId } })).map(role => [role.systemCode,role]));
  }
  const member = await tx.organizationMembership.create({ data: { organizationId: aId, userId, roleId: roles.OWNER.id } });
  const otherMember = await tx.organizationMembership.create({ data: { organizationId: aId, userId: otherId, roleId: roles.OWNER.id } });
  const farms = [];
  for (const [organizationId,code] of [[aId,'A1'],[aId,'A2'],[bId,'B1']]) farms.push(await tx.farm.create({ data: {
    organizationId, code, name:'Field test farm',municipality:'Test',state:'SP',country:'BR',timezone:'America/Sao_Paulo',totalAreaHa:'100',productiveAreaHa:'0',
  } }));
  const [farm, hiddenFarm, foreignFarm] = farms;
  const grant = await tx.farmMembership.create({ data: { organizationId: aId,organizationMembershipId:member.id,farmId:farm.id } });
  const fields = [];
  for (const [parent,code,areaHa] of [[farm,'F1','20'],[farm,'F2','10'],[hiddenFarm,'F1','10'],[foreignFarm,'F1','10']]) {
    fields.push(await tx.field.create({ data: { organizationId:parent.organizationId,farmId:parent.id,code,name:'Test field',areaHa } }));
  }
  const [field,second,hidden,foreign] = fields;
  const session = await tx.authSession.create({ data: { userId,expiresAt:new Date(Date.now()+600000) } });
  const token = await new SignJWT({sid:session.id}).setProtectedHeader({alg:'HS256',typ:'at+jwt'}).setSubject(userId)
    .setIssuer(config.issuer).setAudience(config.audience).setIssuedAt().setExpirationTime('5m').sign(config.jwtKey);
  return {userId,otherId,aId,bId,roles,member,otherMember,farm,hiddenFarm,foreignFarm,grant,field,second,hidden,foreign,session,token};
}
function delegates(tx) { return {authSession:tx.authSession,organizationMembership:tx.organizationMembership,farm:tx.farm,field:tx.field,planting:tx.planting,
  user:tx.user,$queryRaw:tx.$queryRaw.bind(tx),$executeRaw:tx.$executeRaw.bind(tx)}; }
async function harness(database,f,run) {
  class Harness {}
  Module({controllers:[FieldsController,FarmsController],providers:[
    {provide:PrismaService,useValue:database},{provide:AuthConfig,useValue:config},{provide:PasswordService,useValue:{}},
    AuthService,AuthorizationService,PermissionGuard,FieldsService,FarmsService,{provide:APP_GUARD,useClass:AuthGuard},
  ]})(Harness);
  const app = await NestFactory.create(Harness,{logger:false,abortOnError:false,bodyParser:false}); configureHttp(app);
  try {
    await app.listen(0,'127.0.0.1'); const base = await app.getUrl();
    const request = async (path, {method='GET',body,token=f.token,membership=f.member.id}={}) => {
      const response = await fetch(`${base}${path}`,{method,headers:{'Content-Type':'application/json',
        ...(token?{Authorization:`Bearer ${token}`} : {}),...(membership?{'X-Organization-Membership-Id':membership}:{})},
        ...(body!==undefined?{body:JSON.stringify(body)}:{})});
      const text = await response.text(); return {status:response.status,body:text?JSON.parse(text):null};
    };
    await run(request);
  } finally { await app.close(); }
}
async function scenario(run) {
  try { await db.$transaction(async tx => {
    const f = await fixtures(tx);
    const facade = {...delegates(tx),$transaction:async operation => {
      await tx.$executeRawUnsafe('SAVEPOINT field_http');
      try { const result = await operation(tx); await tx.$executeRawUnsafe('RELEASE SAVEPOINT field_http'); return result; }
      catch(error) { await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT field_http'); await tx.$executeRawUnsafe('RELEASE SAVEPOINT field_http'); throw error; }
    }};
    await harness(facade,f,request => run(tx,f,request)); throw rollback;
  },{timeout:30000}); }
  catch(error) {
    if(error===rollback)return; if(error?.name==='AssertionError')throw error;
    // Never print a Prisma cause containing query arguments.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Field test failed safely (${error?.code??error?.name??'unknown'}).`);
  }
}
const path = (farm,id) => `/farms/${farm}/fields${id?`/${id}`:''}`;
const create = (request,f,body=input) => request(path(f.farm.id),{method:'POST',body});
const patch = (request,f,body) => request(path(f.farm.id,f.field.id),{method:'PATCH',body});

test('fields: create unmapped, normalized code and exact Decimal DTO without tenant/relations',()=>scenario(async(tx,f,request)=>{
  const result=await create(request,f,{...input,code:' new ',areaHa:'20.123456',soilType:' Clay '});
  assert.equal(result.status,201); assert.equal(result.body.code,'NEW'); assert.equal(result.body.areaHa,'20.123456');
  assert.equal(result.body.soilType,'Clay'); assert.equal(result.body.boundary,null); assert.equal(result.body.geometryRevision,0);
  assert.equal(result.body.mapped,false); assert.equal(result.body.calculatedAreaHa,null); assert.equal(result.body.areaDifferencePercent,null); assert.equal(result.body.areaNeedsReview,false);
  for(const key of ['organizationId','farm','plantings','memberships'])assert.equal(key in result.body,false);
  assert.equal((await tx.field.findUnique({where:{id:result.body.id}})).organizationId,f.aId);
}));
test('fields: Polygon normalizes to MultiPolygon, geography area is plausible and declared capacity stays official',()=>scenario(async(_tx,f,request)=>{
  const result=await create(request,f,{...input,boundary:polygon()}); assert.equal(result.status,201);
  assert.equal(result.body.boundary.type,'MultiPolygon'); assert.equal(result.body.geometryRevision,1); assert.equal(result.body.mapped,true);
  assert.ok(Number(result.body.calculatedAreaHa)>1&&Number(result.body.calculatedAreaHa)<2);
  assert.equal(result.body.areaHa,'20'); assert.equal(result.body.areaNeedsReview,true);
  const detail=await request(path(f.farm.id,result.body.id)); assert.deepEqual(detail.body,result.body);
}));
test('fields: MultiPolygon, holes and high-precision geometry round-trip without shape changes',()=>scenario(async(tx,f,request)=>{
  const source=polygon(-50.12345678912345,-20.12345678912345,0.0001);
  const result=await patch(request,f,{boundary:{type:'MultiPolygon',coordinates:[source.coordinates]}}); assert.equal(result.status,200);
  const [check]=await tx.$queryRaw`SELECT ST_Equals("boundary", ST_GeomFromGeoJSON(${JSON.stringify(result.body.boundary)})) AS equal, ST_IsValid(ST_GeomFromGeoJSON(${JSON.stringify(result.body.boundary)}),0) AS valid FROM "Field" WHERE "organizationId"=${f.aId}::uuid AND "farmId"=${f.farm.id}::uuid AND "id"=${f.field.id}::uuid`;
  assert.equal(check.equal,true); assert.equal(check.valid,true);
  const tiny=await patch(request,f,{boundary:polygon(1e-20,1e-20,1e-20)}); assert.equal(tiny.status,200);
  const [tinyCheck]=await tx.$queryRaw`SELECT ST_IsValid(ST_GeomFromGeoJSON(${JSON.stringify(tiny.body.boundary)}),0) AS valid,
    ST_Equals("boundary",ST_GeomFromGeoJSON(${JSON.stringify(tiny.body.boundary)})) AS equal FROM "Field"
    WHERE "organizationId"=${f.aId}::uuid AND "farmId"=${f.farm.id}::uuid AND "id"=${f.field.id}::uuid`;
  assert.equal(tinyCheck.valid,true);assert.equal(tinyCheck.equal,true);
  // Fixed-decimal output around 1e-7 really loses low-order digits at precision 17.
  assert.equal((await patch(request,f,{boundary:polygon(1.234567891234568e-7,1.234567891234568e-7,1e-7)})).status,400);
  const withHole={type:'Polygon',coordinates:[polygon().coordinates[0],polygon(-49.9998,-19.9998,0.0001).coordinates[0]]};
  assert.equal((await patch(request,f,{boundary:withHole})).status,200);
}));
test('fields: legacy geometry unrepresentable in GeoJSON returns safe 409 but compact list remains available',()=>scenario(async(tx,f,request)=>{
  const legacy=polygon(1.234567891234568e-7,1.234567891234568e-7,1e-7);
  await tx.$executeRaw`UPDATE "Field" SET "boundary"=ST_Multi(ST_GeomFromGeoJSON(${JSON.stringify(legacy)}))
    WHERE "organizationId"=${f.aId}::uuid AND "farmId"=${f.farm.id}::uuid AND "id"=${f.field.id}::uuid`;
  const before=await tx.field.findUnique({where:{id:f.field.id},select:{geometryRevision:true,name:true}});
  const result=await request(path(f.farm.id,f.field.id));assert.equal(result.status,409);assert.equal('boundary' in result.body,false);
  assert.equal((await request(path(f.farm.id))).status,200);
  assert.equal((await patch(request,f,{name:'Must rollback'})).status,409);
  const after=await tx.field.findUnique({where:{id:f.field.id},select:{geometryRevision:true,name:true}});assert.deepEqual(after,before);
  assert.equal((await patch(request,f,{boundary:null})).status,200);
}));
test('fields: revision tracks changes, no-op and removal; geometry and metadata rollback together',()=>scenario(async(_tx,f,request)=>{
  let result=await patch(request,f,{boundary:polygon(),notes:'first'}); assert.equal(result.body.geometryRevision,1);
  result=await patch(request,f,{boundary:polygon()}); assert.equal(result.body.geometryRevision,1);
  result=await patch(request,f,{name:'Keep geometry'}); assert.equal(result.body.geometryRevision,1); assert.equal(result.body.mapped,true);
  const invalid={type:'Polygon',coordinates:[[[0,0],[1,1],[1,0],[0,1],[0,0]]]};
  assert.equal((await patch(request,f,{name:'Must rollback',boundary:invalid})).status,400);
  result=await request(path(f.farm.id,f.field.id)); assert.equal(result.body.name,'Keep geometry'); assert.equal(result.body.geometryRevision,1);
  result=await patch(request,f,{boundary:polygon(-50,-20,0.002)}); assert.equal(result.body.geometryRevision,2);
  result=await patch(request,f,{boundary:null,notes:null}); assert.equal(result.body.geometryRevision,3); assert.equal(result.body.mapped,false); assert.equal(result.body.notes,null);
  result=await patch(request,f,{boundary:null}); assert.equal(result.body.geometryRevision,3);
}));
test('fields: strict GeoJSON rejects invalid topology, empty/open rings, 3D, range, CRS and non-Geometry payloads',()=>scenario(async(_tx,f,request)=>{
  const invalids=[{},[],{type:['MultiPolygon'],coordinates:[polygon().coordinates]},
    {type:{toString:null},coordinates:polygon().coordinates},{type:null,coordinates:polygon().coordinates},
    {type:'Point',coordinates:[0,0]},{type:'Feature',geometry:polygon()},
    {...polygon(),crs:{type:'name',properties:{name:'EPSG:3857'}}},{...polygon(),srid:3857},{...polygon(),bbox:[0,0,1,1]},
    {type:'Polygon',coordinates:[]},{type:'MultiPolygon',coordinates:[]},{type:'Polygon',coordinates:[[]]},
    {type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1]]]},{type:'Polygon',coordinates:[[[0,0],[1,0],[0,0]]]},
    {type:'Polygon',coordinates:[[[0,0,1],[1,0,1],[1,1,1],[0,0,1]]]},polygon(180,0,1),polygon(0,90,1),
    {type:'Polygon',coordinates:[[['0',0],[1,0],[1,1],['0',0]]]},
    {type:'Polygon',coordinates:[[[0,0],[1,1],[1,0],[0,1],[0,0]]]}];
  for(const boundary of invalids) assert.equal((await patch(request,f,{boundary})).status,400);
}));
test('fields: geometry complexity and global 8KiB body limit are enforced',()=>scenario(async(_tx,f,request)=>{
  const ring=Array.from({length:257},()=>[0,0]);
  for(const boundary of [{type:'Polygon',coordinates:[ring]}, {type:'Polygon',coordinates:Array.from({length:33},()=>polygon().coordinates[0])},
    {type:'MultiPolygon',coordinates:Array.from({length:17},()=>polygon().coordinates)}]) {
    assert.equal((await patch(request,f,{boundary})).status,400);
  }
  assert.equal((await patch(request,f,{notes:'x'.repeat(9000)})).status,413);
}));
test('fields: list projection is compact, ordered and paginated without boundary; unknown query is rejected',()=>scenario(async(_tx,f,request)=>{
  await patch(request,f,{boundary:polygon()});
  const result=await request(`${path(f.farm.id)}?limit=1`); assert.equal(result.status,200); assert.equal(result.body.items.length,1); assert.equal(result.body.hasMore,true);
  assert.equal('boundary' in result.body.items[0],false); assert.equal('description' in result.body.items[0],false);
  const next=await request(`${path(f.farm.id)}?limit=1&offset=1`); assert.equal(next.body.hasMore,false);
  assert.deepEqual([result.body.items[0].id,next.body.items[0].id],[f.field.id,f.second.id].sort());
  for(const query of ['organizationId=x','farmId=x','limit=101','offset=10001','limit=1&limit=2'])assert.equal((await request(`${path(f.farm.id)}?${query}`)).status,400);
}));
for(const role of ['MANAGER','AGRONOMIST'])test(`fields: ${role} uses fields.manage and farms.read only on assigned farms`,()=>scenario(async(tx,f,request)=>{
  await tx.organizationMembership.update({where:{id:f.member.id},data:{roleId:f.roles[role].id}});
  assert.equal((await create(request,f)).status,201); assert.equal((await request(path(f.farm.id))).status,200);
  assert.equal((await request(path(f.hiddenFarm.id))).status,404);
  assert.equal((await request(path(f.hiddenFarm.id),{method:'POST',body:input})).status,404);
  await tx.farmMembership.update({where:{id:f.grant.id},data:{status:'REVOKED',revokedAt:new Date()}});
  assert.equal((await patch(request,f,{name:'Denied'})).status,404); assert.equal((await request(path(f.farm.id))).status,404);
}));
test('fields: OWNER has no capability bypass; WORKER cannot read full operational fields',()=>scenario(async(tx,f,request)=>{
  await tx.rolePermission.delete({where:{roleId_permissionCode:{roleId:f.roles.OWNER.id,permissionCode:'fields.manage'}}});
  assert.equal((await create(request,f)).status,403);
  await tx.organizationMembership.update({where:{id:f.member.id},data:{roleId:f.roles.WORKER.id}});
  assert.equal((await request(path(f.farm.id))).status,403); assert.equal((await patch(request,f,{name:'Denied'})).status,403);
}));
test('fields: cross-tenant, wrong-farm, missing and malformed resources share 404 without leaking geometry',()=>scenario(async(_tx,f,request)=>{
  const results=[];
  for(const [farm,id]of[[f.foreignFarm.id,f.foreign.id],[f.farm.id,f.hidden.id],[f.farm.id,f.foreign.id],[f.farm.id,randomUUID()],[f.farm.id,'bad'],['bad',f.field.id]]) {
    results.push(await request(path(farm,id))); assert.equal((await request(path(farm,id),{method:'PATCH',body:{name:'Denied'}})).status,404);
  }
  for(const result of results){assert.equal(result.status,404);assert.deepEqual(result.body,results[0].body);}
  assert.equal((await request(path(f.foreignFarm.id))).status,404);
}));
test('fields: identity, other user membership and organization state are revalidated',()=>scenario(async(tx,f,request)=>{
  assert.equal((await request(path(f.farm.id),{token:''})).status,401);
  assert.equal((await request(path(f.farm.id),{membership:f.otherMember.id})).status,403);
  await tx.organization.update({where:{id:f.aId},data:{status:'SUSPENDED'}});
  assert.equal((await request(path(f.farm.id))).status,403);
}));
test('fields: allowlist, exact Decimal and required metadata validation prevent mass assignment',()=>scenario(async(_tx,f,request)=>{
  for(const key of ['organizationId','farmId','id','geometryRevision','createdAt','updatedAt','calculatedAreaHa','cropId','status'])
    assert.equal((await create(request,f,{...input,[key]:'forged'})).status,400);
  for(const areaHa of [0,20,'0','-1','NaN','Infinity','1e2','1.0000001','1000000000000','01'])assert.equal((await patch(request,f,{areaHa})).status,400);
  for(const body of [{},{name:null},{code:''},{soilType:123},{name:'x'.repeat(161)},{boundary:'DROP TABLE Field'}])assert.equal((await patch(request,f,body)).status,400);
  const safe="O'Brien; SELECT 1"; const result=await patch(request,f,{notes:safe}); assert.equal(result.body.notes,safe);
}));
test('fields: duplicate normalized codes conflict only within the farm',()=>scenario(async(_tx,f,request)=>{
  assert.equal((await create(request,f,{...input,code:' f1 '})).status,409);
  assert.equal((await request(path(f.hiddenFarm.id),{method:'POST',body:{...input,code:'F2'}})).status,201);
  assert.equal((await patch(request,f,{code:'F2'})).status,409);
}));
test('fields: active capacity enforced for create, area change and reactivation; inactive farm rejects writes',()=>scenario(async(tx,f,request)=>{
  assert.equal((await create(request,f,{...input,areaHa:'70'})).status,201);
  assert.equal((await create(request,f,{...input,code:'EXCESS',areaHa:'1'})).status,409);
  assert.equal((await patch(request,f,{areaHa:'21'})).status,409);
  assert.equal((await patch(request,f,{status:'INACTIVE'})).status,200);
  assert.equal((await patch(request,f,{areaHa:'30'})).status,200);
  assert.equal((await patch(request,f,{status:'ACTIVE'})).status,409);
  assert.equal((await patch(request,f,{name:'History edit'})).status,200);
  await tx.farm.update({where:{id:f.farm.id},data:{status:'INACTIVE'}});
  assert.equal((await patch(request,f,{notes:'Denied'})).status,409); assert.equal((await create(request,f,{...input,code:'NO'})).status,409);
  assert.equal((await request(path(f.farm.id,randomUUID()),{method:'PATCH',body:{notes:'Missing'}})).status,404);
  assert.equal((await request(path(f.farm.id,f.field.id))).status,200);
}));
test('fields: existing capacity drift does not block metadata-only updates',()=>scenario(async(tx,f,request)=>{
  await tx.field.update({where:{id:f.second.id},data:{areaHa:'100'}});
  assert.equal((await patch(request,f,{notes:'Review pending'})).status,200);
  assert.equal((await patch(request,f,{areaHa:'21'})).status,409);
}));
test('fields: reduction preserves individual historical planting capacity and inactivation keeps history',()=>scenario(async(tx,f,request)=>{
  const season=await tx.season.create({data:{organizationId:f.aId,farmId:f.farm.id,code:'TEST',name:'Test',startDate:new Date('2026-01-01'),expectedEndDate:new Date('2026-12-31')}});
  const crop=await tx.crop.findFirst({where:{scope:'GLOBAL',code:'SOYBEAN'}});
  await tx.planting.create({data:{organizationId:f.aId,farmId:f.farm.id,fieldId:f.field.id,seasonId:season.id,cropId:crop.id,plannedAreaHa:'15',plannedStartDate:new Date('2026-01-01'),status:'FINISHED',actualAreaHa:'15',actualStartDate:new Date('2026-01-01'),actualEndDate:new Date('2026-02-01')}});
  assert.equal((await patch(request,f,{areaHa:'10'})).status,409);
  assert.equal((await patch(request,f,{status:'INACTIVE',boundary:polygon()})).status,200);
  assert.equal(await tx.planting.count({where:{fieldId:f.field.id}}),1);
}));
test('fields: divergence uses unrounded geography area and 2 percent comparison',()=>scenario(async(tx,f,request)=>{
  await patch(request,f,{boundary:polygon()});
  const [{area}]=await tx.$queryRaw`SELECT (ST_Area("boundary"::geography)/10000)::text AS area FROM "Field" WHERE "organizationId"=${f.aId}::uuid AND "farmId"=${f.farm.id}::uuid AND "id"=${f.field.id}::uuid`;
  const {Prisma}=await import('../dist/generated/prisma/client.js');
  const measured=new Prisma.Decimal(area);
  for(const divisor of ['1.01999','1.02001']){
    const declared=measured.div(divisor).toFixed(6);
    const result=await patch(request,f,{areaHa:declared});assert.equal(result.status,200);
    const difference=measured.minus(declared).abs().div(declared).times(100);
    assert.equal(result.body.areaNeedsReview,difference.gt(2));assert.equal(result.body.areaDifferencePercent,difference.toFixed(6));
  }
}));

async function concurrent(run){
  let f;
  try{
    f=await db.$transaction(tx=>fixtures(tx,true));
    await harness({...delegates(db),$transaction:db.$transaction.bind(db)},f,request=>run(f,request));
  }catch(error){if(error?.name==='AssertionError')throw error;
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Concurrent field test failed safely (${error?.code??error?.name??'unknown'}).`);
  }finally{if(f)await db.$transaction(async tx=>{
    await tx.field.deleteMany({where:{organizationId:{in:[f.aId,f.bId]}}});
    await tx.farmMembership.deleteMany({where:{organizationId:f.aId}});
    await tx.farm.deleteMany({where:{organizationId:{in:[f.aId,f.bId]}}});
    await tx.authSession.deleteMany({where:{userId:f.userId}});
    await tx.organizationMembership.deleteMany({where:{organizationId:f.aId}});
    await tx.rolePermission.deleteMany({where:{organizationId:f.aId}});await tx.role.deleteMany({where:{organizationId:f.aId}});
    await tx.organization.deleteMany({where:{id:{in:[f.aId,f.bId]}}});await tx.user.deleteMany({where:{id:{in:[f.userId,f.otherId]}}});
  });}
}
async function race(f,operations){
  let requests=[];
  try{
    await db.$transaction(async blocker=>{
      const [{pid}]=await blocker.$queryRaw`SELECT pg_backend_pid() AS pid`;
      await blocker.$queryRaw`SELECT "id" FROM "Farm" WHERE "organizationId"=${f.aId}::uuid AND "id"=${f.farm.id}::uuid FOR UPDATE`;
      requests=operations.map(operation=>operation()); const deadline=Date.now()+2000;let blocked;
      do{
        const [state]=await db.$queryRaw`WITH RECURSIVE waiting AS (
          SELECT activity.pid FROM pg_stat_activity activity WHERE ${pid}::int=ANY(pg_blocking_pids(activity.pid))
          UNION SELECT activity.pid FROM pg_stat_activity activity JOIN waiting ON waiting.pid=ANY(pg_blocking_pids(activity.pid))
        ) SELECT count(*)::int AS blocked FROM waiting`;
        blocked=state.blocked;if(blocked<2)await delay(15);
      }while(blocked<2&&Date.now()<deadline);
      assert.equal(blocked,2,'Both writers must overlap on the Farm lock');
    });
    return await Promise.all(requests);
  }finally{await Promise.allSettled(requests);}
}
test('fields: concurrent creates cannot overbook active farm capacity',()=>concurrent(async(f,request)=>{
  const results=await race(f,[()=>create(request,f,{...input,code:'C1',areaHa:'40'}),()=>create(request,f,{...input,code:'C2',areaHa:'40'})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  const sum=await db.field.aggregate({where:{organizationId:f.aId,farmId:f.farm.id,status:'ACTIVE'},_sum:{areaHa:true}});assert.equal(sum._sum.areaHa.toString(),'70');
}));
test('fields: Field creation and Farm capacity reduction serialize through the same lock',()=>concurrent(async(f,request)=>{
  const results=await race(f,[()=>create(request,f,{...input,code:'NEW',areaHa:'50'}),()=>request(`/farms/${f.farm.id}`,{method:'PATCH',body:{totalAreaHa:'70'}})]);
  assert.ok((results[0].status===201&&results[1].status===409)||(results[0].status===409&&results[1].status===200));
  const farm=await db.farm.findUnique({where:{id:f.farm.id}}),sum=await db.field.aggregate({where:{organizationId:f.aId,farmId:f.farm.id,status:'ACTIVE'},_sum:{areaHa:true}});
  assert.ok(sum._sum.areaHa.lte(farm.totalAreaHa));
}));
test('fields: concurrent same-field metadata/area and geometry patches preserve both changes and revision',()=>concurrent(async(f,request)=>{
  const results=await race(f,[()=>patch(request,f,{name:'Concurrent',areaHa:'25'}),()=>patch(request,f,{boundary:polygon()})]);
  assert.deepEqual(results.map(r=>r.status),[200,200]);
  const final=await request(path(f.farm.id,f.field.id));assert.equal(final.body.name,'Concurrent');assert.equal(final.body.areaHa,'25');assert.equal(final.body.geometryRevision,1);assert.equal(final.body.mapped,true);
}));


test('fields: reduction rejects historical temporal peak even when individual plantings fit',()=>scenario(async(tx,f,request)=>{
  const season=await tx.season.create({data:{organizationId:f.aId,farmId:f.farm.id,code:'PEAK',name:'Peak',startDate:new Date('2026-01-01'),expectedEndDate:new Date('2026-12-31')}});
  const crop=await tx.crop.findFirstOrThrow({where:{scope:'GLOBAL',code:'SOYBEAN'}});
  for(const area of ['12','8']) await tx.planting.create({data:{organizationId:f.aId,farmId:f.farm.id,fieldId:f.field.id,seasonId:season.id,cropId:crop.id,plannedAreaHa:area,actualAreaHa:area,plannedStartDate:new Date('2026-01-01'),actualStartDate:new Date('2026-01-01'),actualEndDate:new Date('2026-02-01'),status:'FINISHED'}});
  assert.equal((await patch(request,f,{areaHa:'15'})).status,409);
  assert.equal((await patch(request,f,{notes:'Preserved'})).status,200);
  assert.equal((await tx.field.findUniqueOrThrow({where:{id:f.field.id}})).areaHa.toString(),'20');
}));
