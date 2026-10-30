import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import test, { afterEach, beforeEach, mock } from "node:test";
import handler, { imageFetchDns } from "../api/inference.js";
import { PROVIDER_CONFIG } from "../lib/provider-config.js";

const URL = "https://samsamskies-inference.replit.app/v1/chat/completions";
const MODEL = "google/gemma-4-26b-a4b-it";
const VISION_HINT = "The first user message includes the note's images before the text. Look at those images when they matter.";
const messages = [{ role: "system", content: "Respond in Spanish unless the user requests another language." },
  { role: "user", content: "Hello" }, { role: "assistant", content: "Hola" },
  { role: "user", content: "Reply in French." }];
const envNames = ["DEFAULT_INFERENCE_PROVIDER", "INFERENCE_FALLBACK_ENABLED", "INFERENCE_CLIENT_DAILY_LIMIT",
  ...Object.values(PROVIDER_CONFIG).flatMap(({keyEnv, modelEnv}) => [keyEnv, modelEnv])];
const originalFetch = globalThis.fetch;
const originalLookup = imageFetchDns.lookupAll;
let previous;
beforeEach(() => {
  previous = envNames.map((name) => process.env[name]);
  envNames.forEach((name) => delete process.env[name]);
  process.env.REPLIT_API_KEY = "test-replit-key";
  globalThis.fetch = () => { throw new Error("Unexpected network call"); };
  imageFetchDns.lookupAll = async () => [{address:"203.0.113.10",family:4}];
});
afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  imageFetchDns.lookupAll = originalLookup;
  envNames.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name];
    else process.env[name] = previous[i];
  });
});

async function call({method="POST", url="/api/inference?provider=replit", token=crypto.randomUUID(),
  body={messages,webSearch:false}} = {}) {
  const res = {statusCode:200,headers:{},body:null,
    setHeader(name,value){this.headers[name]=value;},
    status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;},end(){return this;}};
  await handler({method,url,headers:{host:"example.test",origin:"https://example.test","x-inference-client":token},body},res);
  return res;
}
function success(content="Bonjour", extra={}) {
  return Response.json({choices:[{message:{role:"assistant",content}}],...extra});
}

test("Replit probes require its own key and respect the fallback switch", async () => {
  assert.deepEqual((await call({method:"GET"})).body,{ok:true});
  delete process.env.REPLIT_API_KEY;
  process.env.OLLAMA_API_KEY="other-provider-key";
  process.env.GEMINI_API_KEY="other-provider-key";
  for (const method of ["GET","POST"]) {
    const response=await call({method});
    assert.equal(response.statusCode,503);
    assert.equal(response.body.error,"missing_api_key");
  }
  process.env.REPLIT_API_KEY="test-replit-key";
  process.env.INFERENCE_FALLBACK_ENABLED="false";
  assert.equal((await call()).body.error,"disabled");
});

test("Replit sends native chat, reasoning and temperature to the fixed gateway", async () => {
  globalThis.fetch=async (url,init) => {
    assert.equal(url,URL);
    assert.equal(init.headers.Authorization,"Bearer test-replit-key");
    assert.equal(init.redirect,"error");
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(init.body),{model:MODEL,messages,stream:false,max_tokens:2048,
      reasoning_effort:"none",temperature:0});
    return success();
  };
  const response=await call({body:{messages,webSearch:false,options:{reasoningEffort:"none",temperature:0}}});
  assert.equal(response.statusCode,200);
  assert.deepEqual(response.body,{content:"Bonjour",model:MODEL});
});

test("configured and returned Replit models take precedence over client model fields", async () => {
  process.env.REPLIT_MODEL="configured/model";
  globalThis.fetch=async (url,init) => {
    assert.equal(url,URL);
    assert.equal(JSON.parse(init.body).model,"configured/model");
    return success("Answer",{model:"actual/model"});
  };
  const response=await call({body:{messages,webSearch:false,model:"client/model",baseUrl:"https://untrusted.test",apiKey:"client-key"}});
  assert.equal(response.statusCode,200);
  assert.equal(response.body.model,"actual/model");
});

test("Replit hosted web search is gateway-managed and citations become source links", async () => {
  let calls=0;
  globalThis.fetch=async (_url,init) => {
    calls++;
    assert.deepEqual(JSON.parse(init.body).tools,[{type:"openrouter:web_search"}]);
    return success("Search answer",{choices:[{message:{role:"assistant",content:"Search answer",annotations:[
      {type:"url_citation",url_citation:{url:"https://replit.com/",title:"Replit"}},
      {type:"url_citation",url_citation:{url:"https://replit.com/",title:"Duplicate"}},
      {type:"url_citation",url_citation:{url:"javascript:alert(1)",title:"unsafe"}},
      {type:"url_citation",url_citation:{url:"not-a-url"}},null,
    ]}}]});
  };
  const response=await call({body:{messages}});
  assert.equal(response.statusCode,200);
  assert.equal(response.body.content,"Search answer\n\nSources:\n- [Replit](https://replit.com/)");
  assert.equal(calls,1);
});

test("Replit reasoning efforts map to the OpenAI-compatible field and auto omits it", async () => {
  for (const effort of [undefined,"auto","none","low","medium","high"]) {
    globalThis.fetch=async (_url,init) => {
      assert.equal(JSON.parse(init.body).reasoning_effort,effort === "auto" ? undefined : effort);
      return success();
    };
    assert.equal((await call({body:{messages,webSearch:false,options:{reasoningEffort:effort}}})).statusCode,200);
  }
});

test("Replit retries rejected reasoning or temperature once within the same deadline", async () => {
  for (const [error,field] of [
    ["Reasoning is mandatory for this endpoint and cannot be disabled.","reasoning_effort"],
    ["reasoning_effort is not supported","reasoning_effort"],
    ["temperature only supports the default; unsupported temperature","temperature"],
  ]) {
    const requests=[];
    globalThis.fetch=async (_url,init) => {
      requests.push(init);
      if (requests.length===1) return Response.json({error:{metadata:{raw:JSON.stringify({error:{message:error}})}}},{status:400});
      assert.equal(JSON.parse(init.body)[field],undefined);
      return success();
    };
    assert.equal((await call({body:{messages,webSearch:false,options:{reasoningEffort:"none",temperature:0}}})).statusCode,200);
    assert.equal(requests.length,2);
    assert.equal(requests[0].signal,requests[1].signal);
  }
  let calls=0;
  globalThis.fetch=async () => {calls++;return Response.json({error:{message:"unsupported reasoning_effort"}},{status:400});};
  assert.equal((await call({body:{messages,options:{reasoningEffort:"none"}}})).body.error,"provider_error");
  assert.equal(calls,2);
});

test("Replit maps auth, model, credit, rate and capacity failures and releases daily quota", async () => {
  process.env.INFERENCE_CLIENT_DAILY_LIMIT="1";
  const token=crypto.randomUUID();
  for (const [http,status,error] of [[401,502,"provider_auth"],[403,502,"provider_auth"],
    [404,502,"model_unavailable"],[402,429,"quota_exhausted"],[429,429,"rate_limited"],
    [500,503,"provider_busy"],[503,503,"provider_busy"],[400,502,"provider_error"]]) {
    let calls=0;
    globalThis.fetch=async () => {calls++;return new Response("upstream failure",{status:http,headers:{"Retry-After":"30"}});};
    const response=await call({token});
    assert.equal(response.statusCode,status);
    assert.equal(response.body.error,error);
    assert.equal(calls,1);
    if (http===429) assert.equal(response.headers["Retry-After"],"30");
  }
  globalThis.fetch=async () => success();
  assert.equal((await call({token})).statusCode,200);
  assert.equal((await call({token})).body.error,"client_limit");
});

test("Replit Retry-After accepts HTTP dates and defaults unreadable values", async () => {
  const now=Date.now();
  mock.method(Date,"now",()=>now);
  for (const [header,expected] of [[new Date(now+60_000).toUTCString(),"60"],["garbage","60"],["0","1"]]) {
    globalThis.fetch=async () => new Response("limited",{status:429,headers:{"Retry-After":header}});
    assert.equal((await call()).headers["Retry-After"],expected);
  }
});

test("malformed Replit replies and unexpected tool calls fail without exposing reasoning", async () => {
  for (const response of [new Response("not JSON"),Response.json(null),Response.json({error:{message:"bad"}}),
    Response.json({choices:[]}),success(null),success(""),success("partial",{choices:[{finish_reason:"error",message:{role:"assistant",content:"partial"}}]}),
    success("partial",{choices:[{message:{role:"assistant",content:"partial",tool_calls:[{function:{name:"web_fetch"}}]}}]}),
  ]) {
    globalThis.fetch=async () => response;
    assert.equal((await call()).body.error,"provider_error");
  }
  globalThis.fetch=async () => success(null,{choices:[{message:{role:"assistant",reasoning:"hidden",content:[
    {type:"reasoning",text:"hidden"},{type:"text",text:"Visible"},null,
  ]}}]});
  assert.equal((await call()).body.content,"Visible");
});

test("Replit timeouts return provider_busy and release daily quota", async () => {
  process.env.INFERENCE_CLIENT_DAILY_LIMIT="1";
  const token=crypto.randomUUID();
  mock.method(AbortSignal,"timeout",()=>AbortSignal.abort(new DOMException("Timed out","TimeoutError")));
  assert.equal((await call({token})).body.error,"provider_busy");
  mock.restoreAll();
  globalThis.fetch=async () => success();
  assert.equal((await call({token})).statusCode,200);
});

test("Replit receives downloaded and inline images as data URLs", async () => {
  const imageRequests=mock.method(https,"request",(options,onResponse) => {
    assert.equal(options.hostname,"203.0.113.10");
    const req=new EventEmitter();
    req.end=()=>queueMicrotask(()=>{
      const incoming=new EventEmitter();incoming.statusCode=200;incoming.headers={"content-type":"image/png"};incoming.destroy=()=>{};
      onResponse(incoming);incoming.emit("data",Buffer.from([1,2,3]));incoming.emit("end");
    });return req;
  });
  globalThis.fetch=async (_url,init) => {
    const sent=JSON.parse(init.body).messages;
    assert.equal(sent[0].content,VISION_HINT);
    assert.deepEqual(sent[1].content,[
      {type:"image_url",image_url:{url:"data:image/png;base64,AQID"}},
      {type:"image_url",image_url:{url:"data:image/jpeg;base64,BAUG"}},
      {type:"text",text:"Describe these"},
    ]);
    return success();
  };
  const response=await call({body:{webSearch:false,messages:[{role:"system",content:VISION_HINT},{role:"user",content:[
    {type:"image",url:"https://images.example.test/photo.png"},
    {type:"image",mediaType:"image/jpeg",data:"BAUG"},{type:"text",text:"Describe these"},
  ]}]}});
  assert.equal(response.statusCode,200);
  assert.equal(imageRequests.mock.callCount(),1);
});

test("Replit unsafe image URLs become text and the stale vision hint is removed", async () => {
  const imageRequests=mock.method(https,"request",()=>{throw new Error("must not fetch private image");});
  imageFetchDns.lookupAll=async ()=>[{address:"127.0.0.1",family:4}];
  globalThis.fetch=async (_url,init) => {
    assert.deepEqual(JSON.parse(init.body).messages,[{role:"system",content:"Explain this."},
      {role:"user",content:"Describe this\n\nhttps://private.example.test/photo.png"}]);
    return success();
  };
  assert.equal((await call({body:{webSearch:false,messages:[{role:"system",content:`Explain this.\n${VISION_HINT}`},
    {role:"user",content:[{type:"image",url:"https://private.example.test/photo.png"},{type:"text",text:"Describe this"}]}]}})).statusCode,200);
  assert.equal(imageRequests.mock.callCount(),0);
});

test("Replit can be the default while concurrent requests keep three providers separate", async () => {
  process.env.DEFAULT_INFERENCE_PROVIDER="replit";
  process.env.OLLAMA_API_KEY="test-ollama-key";process.env.OLLAMA_MODEL="ollama-model";
  process.env.GEMINI_API_KEY="test-gemini-key";process.env.GEMINI_MODEL="gemini-model";
  process.env.REPLIT_MODEL="replit-model";
  globalThis.fetch=async (url,init) => {
    await new Promise((resolve)=>setImmediate(resolve));
    if (url===URL) {
      assert.equal(init.headers.Authorization,"Bearer test-replit-key");
      assert.equal(JSON.parse(init.body).model,"replit-model");return success();
    }
    if (url==="https://ollama.com/api/chat") {
      assert.equal(init.headers.Authorization,"Bearer test-ollama-key");
      assert.equal(JSON.parse(init.body).model,"ollama-model");return Response.json({message:{role:"assistant",content:"Ollama"}});
    }
    assert.match(url,/models\/gemini-model:generateContent\?key=test-gemini-key$/);
    return Response.json({candidates:[{content:{parts:[{text:"Gemini"}]}}]});
  };
  const responses=await Promise.all([call({url:"/api/inference"}),call({url:"/api/inference?provider=ollama"}),call({url:"/api/inference?provider=gemini"})]);
  assert.deepEqual(responses.map((res)=>res.statusCode),[200,200,200]);
  assert.deepEqual(responses.map((res)=>res.body.model),["replit-model","ollama-model","gemini-model"]);
});
