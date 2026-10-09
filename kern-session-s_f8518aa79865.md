# kern session

- model: nvidia/nvidia/nemotron-3.5-lightning-30b-a3b
- cwd: /workspaces/mathcode.com

## user

Summarize this repo

*model → nvidia/nvidia/nemotron-3.5-lightning-30b-a3b*

## user

hi

## assistant




> thinking: We need to summarize the repo. First we need to see the repo contents. Use read on path "." maybe.

```tool read
{
  "path": "."
}
````

## tool

**tool result:**

- .agents
- .env
- .git
- .gitignore
- Guide.md
- Kern-Kernel.md
- README.md
- node_modules
- package.json
- packages
- pnpm-lock.yaml
- pnpm-workspace.yaml
- session-6f80ecdc-2814-4020-856b-75a61e4d7921.md
- tsconfig.json

## assistant






> thinking: Let me explore the repo structure more to understand what this project is about. I'll read the key files.

```tool read
{
  "path": "README.md"
}
````

```tool read
{
  "path": "package.json"
}
````

```tool read
{
  "path": "pnpm-workspace.yaml"
}
````

## tool

**tool result:**

1: # Agents from First Principle and Scratch
2: Our Prompt : 
3: Your Task is to create a team of expert to search and research -> plan and write detailed notebook from high -> low level design to requirements to implimenentation of the pi agents in detailed from first principle and from scratch remark : for diagram or any others in markdown applicable one user for example mermaid or any other ok -> [intro
4: Good morning, everyone. How's it going today? Today I bring you a new format right here. I'm going to be recording with my iPad,
5: and we're going to be going over the entire architecture of Pi.
6: Pi, of course, has been taking the world by storm, and it's actually very minimalist, and it's very beautifully architected and designed.
7: So we're going to be taking a look at how it works, actually, so that you can think about probably creating your own.
8: It's a very educational project if you want to go about it. Or if you're just interested in understanding what's really happening behind the scenes and why Pi is so well designed, this video is also for you.
9: So we're going to be talking about mainly two things. So we're going to be talking, first of all, about the agent core, which is basically just the agentic loop that runs behind the scenes.
10: And this one right here can also be called via RPC or in a programmatic way via the SDK.
11: And then we're going to be taking a look at the PyInteractive way, which is the actual functionalities that are added via the terminal user interface.
12: Okay. So without any further ado, let's actually get started with the PyCore.
13: Agent loop
14: All right. So let's start off with PyCore. And in order to start with PyCore, I think that it is very, very important to understand
15: that the main part of Py as a design is just its agent core.
16: Okay? In other words, it's agent loop. Let's just call it loop instead. Agent loop.
17: And this is going to be very straightforward. It is essentially all the steps that are going to happen every time that you start a conversation
18: with Py. So let's suppose that you start a conversation with Pi and you're going to go right here.
19: And the first step that's going to happen after you open Pi for the first time and send the first message is it's going to initialize its context.
20: Okay. Now, what does this mean? This means that it's going to put together a bunch of different things.
21: First, it's going to put together its system prompt. And this system prompt is hardcoded into Pi.
22: You can, of course, update it by creating your own system.md in your workspace.
23: But in this case more often it is going to be loading the pre system prompt I probably leave a link in the description if you want to take a look at it It is very very minimalist Don try to make it more minimalist
24: It's already like a few lines of code, a few lines of instructions. After that, it's going to append
25: all the agents.md files that you have, both in home and also in your current working directory.
26: Okay, so of course, be sure to not add too many .agents.md files, because that will just
27: bloat your system prompt. Actually, I think I made a mistake. This is not .agents, just agents.md file. After that, it is going to append all the skills descriptions.
28: Okay, description. So all the skills that you have loaded into your agent, it is going to load the descriptions and it is going to do the same thing with the tools. So all the tool descriptions
29: are also going to go into the initialized context. Okay. And there you go. And then after that,
30: it is going to append your message history like this and your current message right here. So this,
31: if this is a new conversation, then there is not going to be any message history. If this is an
32: ongoing conversation, there is going to be a message history. And if the conversation was compacted, this can be replaced by the summary of your previous message history. Okay, so there you
33: go. That is the initialization context. The second step that happens every single time is this step
34: called the transformation, the transformation of the context. Okay. And what this means is that it
35: is going to take a look at the context that was just created, and it is going to figure out whether or not it needs to compact that context. If it needs to compact, then it is going to compact it
36: and add it right here instead of the message history. Compacting basically means that it
37: takes all of the messages that are right there in the history and summarize them with the LLM,
38: of course, as well. The third step is going to be actually doing the large language model call. So
39: it's going to call your large language model to whichever provider that you have selected. It can be OpenAI GPT 5 it can be Anthropics models it can be Kimi it can be Minimax whatever you want And then your model is going to return a tool call if it wants to make a tool call For example
40: it wants to update a file, read a file, search the internet, etc. And then your tool is going
41: to naturally return a response to your large language model. And then the large language model may decide to make another tool call and then so back so forth. It can do hundreds of tool
42: calls if you're really doing something very complicated or just a couple if you're just searching the web, for example. And then once the agent decides or your layers language model decides
43: that it does not need a tool call, it will just reply and it will give you a response.
44: And there you go. That is essentially everything that happens whenever you send a message to Pi. And that is kind of the core or the agentic loop.
45: It may sound very easy and like it's just a few things that just a very straightforward
46: diagram. But in reality, this is quite a complicated thing.
47: And in Pi, it is coded from scratch. There is no additional library helping Pi build the whole thing right here.
48: And for the record, there are libraries that do this for you that have this agentic loop preloaded.
49: So you just have to import the agent loop and use it. Some examples are, for example, OpenAI Agents SDK.
50: You also have Versus Sales AI SDK and all of this.
51: But in this case, this one right here is completely custom. So that's with the agentic look of Pi.
52: And that's the first thing. The second thing that we're going to take a look at is the sessions and memory.
53: Sessions
54: Okay, and the next thing to understand right here is the memory. Let's just call it like this, memory and sessions.
55: Because this is one of my favorite parts of Pi, actually, which is that it is extremely easy and straightforward to export your sessions,
56: to navigate them, to go to a previous step in the session, to fork it, etc. It is very, very straightforward and very, very well designed.
57: So first of all, where are the sessions stored? The sessions are stored in your home directory inside your directory inside agent and inside sessions
58: And inside here, you're going to see a bunch of different directories. And they're going to be mapped into each one of your working directories.
59: So for example, let's suppose that you were working in an application called dashboard. And it's going to be a dashboard directory.
60: then let's suppose that you were working in an application called weather app.
61: Weather app. There's going to be that directory right here, etc. So here's going to be a list of directories.
62: And then inside each directory, you're going to have each session with their ID, etc.
63: And it's going to be stored in JSON-L. And what this basically means is that it is going to be just a very straightforward,
64: file with the message here like that. It's kind of exactly like a JSON, but instead of having an
65: actual JSON object, it is going to be just a document with a bunch of JSON-like objects and
66: one object in each line. And this, of course, makes it very easy and very straightforward to
67: document this because that means that whenever there is a new message in your conversation,
68: all it has to do is append it in the last line. And these objects, of course, include the role, the message, etc.
69: And there you go. It is extremely straightforward. And as you can see, it stores all of your sessions
70: by the location where you started to work on them. And then every message is just its own JSON object.
71: And this is, of course, easier to update than if you actually had an array,
72: then you would have to update just a single part of the whole thing. JSON-L is just much more convenient.
73: So that is the thing about sessions. Let me actually go into the...
74: I'm going to show you that in just a moment in the actual Py command line to show you how this actually works.
75: But before we do that, let me show you something that is very, very fun,
76: which is the fact that these sessions right here are stored in not in a list.
77: So it's not a list of sessions. So not a list, but it's actually a tree of sessions.
78: In other words, you probably have seen that in order to navigate in Py to a previous command
79: or a previous prompt that you gave, you do slash tree. And the reason for that is that all of these messages right here,
80: they have, of course, the role, the message, and they also have a property called parent.
81: And they also have their ID. So this one right here, the parent will refer the fact
82: that this message bifurcated probably from a previous message.
83: So right here we can have the role, all of its information, and here we have the parent, and this parent will be 111.
84: And this one right here is going to have an ID of 111. So now Pi knows that this message comes before this one,
85: but maybe you bifurcated from this one into another message, So you will have another, you fork the conversation.
86: So here you will have all of your conversation history. And here you will have another parent 111.
87: And that basically just creates a tree structure immediately from a single file like this.
88: So now you have two different messages that come from the same parent message.
89: And that creates two different forked conversations. It is just a beautiful design.
90: And I have seen many AI agents trying to migrate into this new tree design rather than just a simple list, one message after the other system.
91: So that is the thing that you're going to be seeing much more often in the coming agents that are coming out.
92: So now that we have seen this in the actual map right here, let's actually show you what it looks like in the screen.
93: All right, so let's go right here into my command line. And as you can see, I have this very nice session
94: where I just talked to the agent about creating some videos, et cetera. And I had my whole video workflow automated right here.
95: And let me show you what happens when you go right here and you do slash tree. As you can see, you have a bunch of different messages.
96: And here, what we're actually doing is we're going vertically. We're navigating through this list of messages
97: in this JSONL file. As you can see a bunch of messages are actually tool calls And a message can be also a user message an assistant message et cetera what going to happen right here let suppose that I want to go right here to this
98: message right here. I can tell it to summarize the previous part of the conversation. And now this is going to create a new message in my JSONL file. And it is going to set it as a parent or as
99: a child message of the message that was right before this one, before I bifurcated. But the
100: other messages are still in the same directory, so in the same list of JSONL messages.
101: So there you go. Here is, and if I go right back into tree, you can see that here we have a bifurcation
102: and you have the summary and the whole thing that I can just take over. Let me show you what this looks like in the actual Py directory.
103: So as I told you, you go to Py, Agent, and inside of here, you go into Sessions.
104: And let me just show you. Inside of here, you have all the sessions in the different directories that I have run Py.
105: So I have Inside Users, Alejandro, Agent Skills, Video Tool. This is one directory.
106: Of course, this is not the exact name of the directory. It is like the path to that in a more standardized way.
107: And I can access any of this. So for example, I suppose that I go into this one right here.
108: I suppose that I go here. And as you can see, I have two sessions right here. So I can just open, for example, the last one, which is going to be this one.
109: And as you can see, it is just a list of JSONL files with all of my conversation right here.
110: And as you can see, every JSONL file starts and ends with this curly braces and just shows
111: the whole thing of what happened. And actually, let me show this to you in code, in VS Code.
112: There you go. Now I open the same thing on VS Code. And as you can see, every single line is a single message.
113: And as you can see, each one contains the type of message, which can be a message. It's ID. It's parent ID, as I was telling you, to create the tree structure, the timestamp, and the
114: actual message right here. So there you go. That is how sessions work.
115: Now let actually take a look at the next part of the PyCore setting which is the tools All right so let talk now very quickly about the tools that it has and actually the as you probably know pi is a very minimalist agent and the tools is the tool list
116: Tools
117: that it has is very minimal as well so it actually only has four tools the first one is the read tool
118: tool then it has a bash tool and then it has an edit tool and a write tool and that's all it has
119: there is no more than that that's you can of course add additional tools to pi if you want
120: you can ask pi to create a new tool you can install packages to for it to add new tools but just out
121: of the box it comes with these four tools i would myself add web search that's the only tool that i
122: always install when I use Pi. So that would be my real minimalist setup. But just by having this,
123: you already have a great minimalist setup, actually. It does, however, let me just mention
124: something very quickly that it's not often mentioned. The fact that, yes, you have four
125: tools, but there are two additional tools that are grep and find. And these additional tools are
126: essentially the same thing or things that you can already do with bash but this additional tools are
127: by default disabled because they are supposed to be enabled only when you want to use pi on read
128: only mode right so you do not you probably don't want to give it access to bash so if you're going
129: to be running pi with slash slash tools sorry dash dash tools and here you pass as an argument
130: And what tools you want to use, you can mention that you only want, for example, read, grep, and find.
131: And that is going to give you a Pi system that will be read-only.
132: And this is, of course, very useful if you're running Pi programmatically. So, for example, if you're running Pi through RPC, that is going to be very useful because you probably don't want Pi to edit your files if you're just automating a few workflows.
133: So that is for the tools, it's very straightforward. Let's now take a very, very quick look on extensions.
134: Extensions
135: So let talk very quickly about extensions and you probably know already what these are if you have used Pi but in case you haven extensions are these packages or things that you can add to Pi to modify its behavior Because of course it is a very minimalist setup
136: It comes with only four tools by default. It does not come with either MCP support or with web search or anything like that.
137: So extensions are kind of this ready-to-use packages that you can just install on top of Pi,
138: and Pi will have all of these features out of the box. And it's very, very cool. Let me tell you some of the things that you can do with extensions.
139: So I'm just going to add here extensions like this.
140: And some of the things that you can do with extensions are, for example, register new tools.
141: You can subscribe to events. And this is very important because that's something that I forgot to mention before
142: is that every part of this entire workflow
143: that happens every time that you have a conversation actually is triggering some events. And these events can be something like tool call,
144: like agent response, like user message, et cetera. And these are events that happen during the workflow.
145: So you can subscribe to events so that these extensions or these packages perform particular actions
146: at a particular time of the agent loop. They can also register commands.
147: They can add keyboard shortcuts, for example. Add CLI flags as well.
148: They can also update the system prompt.
149: Or even render custom messages.
150: And these are extensions that you can code yourself. They are coded in TypeScript. And it's very, very straightforward because Pi naturally allows you to, since it is very modular, you can literally just add an additional extension, plug it to whatever you want to plug it, and it will modify the behavior of Pi.
151: It's very straightforward. And of course, if you're interested in extensions, feel free to take a look at all of the extensions in the packages part of the website.
152: Now, of course, be aware that these packages are naturally loading and executing code in your system.
153: So you probably don't want to install packages from third-party sources that you do not trust.
154: Or if you want to use them, at least run them through PyAgents.
155: have pi explore the code of that particular package to make sure that it is safe so that is
156: one thing now let's talk about skills and

[... 3976 characters truncated ...]

 is if you just run pi like this in the command line and just type your prompt like that Okay So that is the entry point Let talk
195: a little bit about this, particularly on the terminal user interface, because that is also
196: a very interesting thing. All right. So the terminal user interface
197: Terminal UI
198: is actually very straightforward. You have probably already seen it on, I mean, you can see that it is very, very modular.
199: You have your input right here. You have your messages on top. And then you have a bunch of information
200: in the nice little bar at the bottom. And it's pretty useful, actually,
201: pretty fun and very, very minimalist. and it does not flicker, which is great.
202: And yeah, everything works very well in a very minimalist way. And the reason for it is that it is, first of all,
203: it is completely custom built. So it does not use textual or anything like that. It is completely custom.
204: And then something else is that it is component-based. Okay, component-based.
205: And then about that, you have to consider that each component basically is responsible for its own rendering, for its own inputs,
206: and also can be updated dynamically. So yeah, that is something to consider. It can, of course,
207: subscribe to a bunch of different events that are released by the agent core, but it is completely
208: custom built and that does not mean that you cannot add your own graphical user interface on
209: top or your own 2e on top but this one right here the one that comes out of the box is completely
210: custom for pi now let's talk about the compaction or the way that pi deals with compactions because
211: i find that that is very interesting all right so now let's talk very quickly about the way that pi
212: Compaction
213: deals with compaction, because many different agents deal with this in different ways.
214: And I figure that the way that Pi does it is actually not only very minimalist, but also
215: very simple and very intuitive. So I have seen some agents for example try to measure how long your context is by taking the number of characters in the entire context and dividing that by four to figure out how many tokens approximately are there Now that of course I seen some agents
216: do that, especially at the beginning when you don't have a response from the LLM yet, and that seems to work. However, Pi does not do that at all. It just relies on the feedback that
217: the response from the LLM gives you. It just assumes that on the start, you're not going to
218: send a super long message anyways. So what happens is that Pi calls this function called
219: check compaction, check compaction, like that. And it calls it on two different occasions.
220: The first one is when an agent ends. That is to say, when the agent finishes a turn and it gives you the actual response from a tool call or whatever.
221: And also before the prompt. So before the prompt.
222: So if you have, so that is before you actually start sending a message. That's the other moment when this checks for compaction.
223: And the reason, of course, naturally, the check for compaction is that you do not want your context to be too long
224: so that when the agent is going to reply, it is going to just overload the context window.
225: And you, of course, don't want to overload the context window from the start either. So what happens right here is that once the agent responds, it measures how many tokens are in your response.
226: And some agents, some LLM, sorry, some LLM providers actually return to you in the response,
227: the context. Okay, so the context tokens. So if those are present, then it just takes them directly from there.
228: If they are not present, however, it calculates the context by adding together the following
229: things. So usually, whenever an LLM gives you a response, you get a usage, let me just go right here,
230: a usage parameter that includes the usage input, that mentions how many tokens you input,
231: then includes the usage.output, that mentions how many tokens were generated by the LLM.
232: And on top of that, it usually mentions the cache.read and the cache.write.
233: adding all of this together, let me just say that here, by adding all of this together,
234: then it calculates the context by naturally every single time that an agent ends a turn
235: or before the user sends a prompt. So there you go. That is for compaction. And of course,
236: if you want to take a look at what the compaction actually looks like, it is also very minimalist. Let me see if I can find the actual code right here, because it is very, very fun.
237: Let's see. Oh, here it is. Let me switch to the computer to show you the actual compaction prompt.
238: And here we are. We are inside packages, agent, source, harness, compaction, and inside compactions.ts.
239: And as you can see here, we have the summarization system prompt. It says, let me just wrap this right here. You are a context summarization assistant.
240: Your task is to read a conversation between a user and an AI assistant, blah, blah, blah. And something pretty cool is that here you have the complete system prompt that you have.
241: So the messages above are a conversation to summarize, create a structured context checkpoint summary that another LLM will use to continue the work.
242: And here is the exact format. So you mentioned the goal, the constraints and preferences, the progress, what is done
243: and what is in progress, what is blocked, the key decisions that the agent has made, the next steps and the critical context. Keep each section concise, preserve exact file paths,
244: function names, and error messages. And it has a slightly different prompt for updating an existing
245: already context summary. So as you can see, it is very, very straightforward. And let me see if I can
246: show you something fun right here. Let's see if I can just open this like this. And let's just go
247: back into a working repository. And here I'm in a working repository.
248: I'm just going to resume one of this. Let's see if this works.
249: And there we go. Something that I can do right here is just ask it to compact the whole thing And so we going to see the exact compaction that it generates right here in just a moment And there you go Here we have the compaction
250: And if you want to take a look at it, just do Ctrl-O to expand. And as you can see, we have the exact compaction that follows the prompt that we just saw.
251: So the goal is this. The constraints and preferences are this. The progress, what is done, what is in progress to be done, and what is blocked,
252: the key decisions it has done, the next steps, the critical context, original request, early progress, etc. So there you go. That is how compaction works. Now let's take a look, last
253: but not least, at how the PyInteractiveAgent deals with skills. I think that this is very, very fun.
254: Skills
255: All right, now something that I wanted to mention precisely about this, and it is very interesting,
256: is how Pi deals with scales and with custom prompts.
257: So custom prompts. These are two different things, and they are both dealt in a very similar way.
258: Now, in case you're not familiar with scales, scales are these MD files, MD markdown files
259: that contain a lot of very clear, detailed instructions. And at the header, they have a name and a description
260: that is loaded into the system prompt. And when it comes to custom prompts,
261: they're basically just custom slash commands. So you can do just like your slash command.
262: And this is going to be replaced with your system prompt at the PI interactive layer.
263: So this is never going to reach the actual PI core. And that is very important.
264: Now for custom prompts, it's very, very straightforward. Whenever you send a custom slash command like this, the CLI is going to read it and it is going to turn it into the actual prompt that you had stored in your custom prompts.
265: So that is very straightforward. The part that I find most interesting is how skills are managed.
266: So remember we mentioned before in the system prompt that here there is a section with all the skills available And that is of course the first part of the skills workflow So in the system prompt let just go again mention the system prompt
267: There is a lot of things, and then at some point, there is the list of skills available,
268: as I mentioned before. Okay, just like that. And so now your agent, Pi, and your LLM knows that it has skills to work with.
269: Okay, so it is actually aware that it has skills. It is not aware that it has custom slash commands
270: because they just reach pi completely rendered. But for skills, they don't reach pi completely rendered, actually.
271: What happens is that let's suppose that you... So here's the system prompt. And then the user, you, send your slash skill colon.
272: And then you mention the skill that you want. Let's suppose that your, I don't know, your custom workflow.
273: Now, this right here is going to be intercepted by the interactive layer.
274: So your agent core will not see this command. It has no idea that you call a scale like doing slash scale colon.
275: You could very well use another CLI or another TUI that uses the dollar sign like codex or just a slash command like clotcode, etc.
276: okay so what happens is that when this command reaches the the interactive layer of your agent
277: of your cli this is going to be replaced by the skill like this skill with markup tags which will
278: contain its name, it will contain its description, and it will notably contain its location.
279: And the location right here is basically just telling your agent where this skill is located.
280: So for example it can be located in say pi agent skills It can be for example located in dot agents slash skills And this can be either in the current working directory or in your home directory And this is going to be very important
281: because this data is going to be sent in the message. Okay, so the AI, your LLM does see this,
282: But there is a custom instruction right here in the prompt saying that if a skill is invoked, use the read tool to read it.
283: And what happens is that it will basically just after receiving the skill, it will just call the tool read and it will read this location and then get the response.
284: and continue all the work. So the skills, at least in Pi, are not automatically replaced at the interactive layer.
285: Some other agents that I have seen take this command right here and immediately paste the contents of the skill directly from here.
286: But what Pi does, at least in this interactive layer, of course you can do this differently because this is done outside of the core that we saw before.
287: What it does is it just sends the skill that was called with the name, the description, and its location
288: so that Pi manually opens it with a tool call and gets the results and then just continues with the rest.
289: So there you go. I mean, I think we have covered pretty much everything related to how Pi is built. I feel like you should be ready to at least start with Pi
290: and maybe even create your own version of Pi. I find it very educational. I have been working on things like that before
291: and over the past few weeks, and it's very fun. So I hope that this has been interesting.
292: This is just a kind of a side research project that I was working on.
293: If you're interested in similar videos like this, feel free to let me know. And of course, if you have any questions,
294: post them right here in the comments. I'll be very happy to talk about this. so thanks a lot and I will see you in the next one][https://alejandro-ao.com/pi-architecture/] [https://alejandro-ao.com/pi-architecture/](https://alejandro-ao.com/pi-architecture/)
295: 
296: Our Answer : @.agents/proj/initial.md

## tool

**tool result:**

1: {
2:   "name": "kern",
3:   "version": "0.0.1",
4:   "private": true,
5:   "type": "module",
6:   "description": "Kern — a minimal, from-first-principles terminal coding agent kernel",
7:   "packageManager": "pnpm@12.3.4",
8:   "engines": {
9:     "node": ">=20"
10:   },
11:   "scripts": {
12:     "typecheck": "tsc -p tsconfig.json --noEmit",
13:     "test": "vitest run",
14:     "test:watch": "vitest",
15:     "kern": "tsx packages/cli/src/main.ts"
16:   },
17:   "devDependencies": {
18:     "@types/node": "^24.0.0",
19:     "tsx": "^4.19.2",
20:     "typescript": "^5.7.0",
21:     "vitest": "^3.0.0"
22:   }
23: }

## tool

**tool result:**

1: packages:
2:   - "packages/*"
3: 
4: allowBuilds:
5:   esbuild: true
6: 
7: minimumReleaseAgeExclude:
8:   - '@earendil-works/pi-tui@1.0.4'
9: 

## assistant




> thinking: Let me explore the packages directory to understand the structure better.

```tool read
{
  "path": "packages"
}
````

## tool

**tool result:**

- agent-core
- cli
- coding-agent
- model
- protocol
- session-store
- tools
- tui

## assistant






> thinking: Let me explore the packages to understand the structure better.

```tool read
{
  "path": "packages/agent-core"
}
````

```tool read
{
  "path": "packages/cli"
}
````

```tool read
{
  "path": "packages/coding-agent"
}
````

## tool

**tool result:**

- node_modules
- package.json
- src
- test

## tool

**tool result:**

- dist
- node_modules
- package.json
- src
- test

## tool

**tool result:**

- node_modules
- package.json
- src
- test

## assistant






> thinking: Let me explore the source directories of each package to understand the codebase structure.

```tool read
{
  "path": "packages/agent-core/src"
}
````

```tool read
{
  "path": "packages/cli/src"
}
````

```tool read
{
  "path": "packages/coding-agent/src"
}
````

## tool

**tool result:**

- agent.ts
- budgets.ts
- compaction.ts
- context-builder.ts
- event-bus.ts
- index.ts
- resources.ts
- retry.ts
- tokens.ts

## tool

**tool result:**

- main.ts

## tool

**tool result:**

- create-agent-session.ts
- index.ts

## user

what you can do for me  i don't know

## assistant

Based on my exploration, here's what this repository is about:

## **Kern - A Minimal, From-First-Principles Terminal Coding Agent Kernel**

This is a minimal terminal-based coding agent framework built from first principles. Here's what it does:

### **Core Features**

1. **Agent Core Loop** - Manages the agentic loop: context initialization, compaction, LLM calls, and tool usage
2. **Session Management** - Stores sessions as JSONL files in a tree structure (not just a list), allowing forked conversations and navigation via `slash tree`
3. **Minimal Tool Set** - Comes with 4 basic tools: `read`, `bash`, `edit`, `write`, plus optional `grep` and `find` (disabled by default for read-only mode)
4. **Extensions System** - Plugin-like packages that can register tools, subscribe to events, add commands/CLI flags, update system prompts, and render custom messages
5. **Terminal UI** - Custom-built, component-based TUI that's modular and minimalist

### **Package Structure**

- **`agent-core`** - Core agent logic (context building, compaction, budgets, events, resources)
- **`cli`** - Command-line interface entry point
- **`coding-agent`** - Coding agent session creation
- **`model`** - Model-related functionality
- **`protocol`** - Protocol definitions
- **`session-store`** - Session storage management
- **`tools`** - Tool implementations
- **`tui`** - Terminal user interface

### **How It Works**

1. **Context Initialization**: Loads system prompt, `.agents.md` files, skill descriptions, and tool descriptions
2. **Transformation**: Compacts context when needed (based on LLM feedback, not character counting)
3. **LLM Call**: Calls the selected LLM provider
4. **Tool Calls**: If LLM requests tools, executes them (read, bash, edit, write)
5. **Response**: Returns LLM's final response when no more tool calls needed

The project is designed as an educational exploration of how AI agents like Pi are architected from scratch, without relying on pre-built agent frameworks.

Would you like me to dive deeper into any specific part of the codebase?

> thinking: The user is asking "what you can do for me i don't know". They seem to be asking about my capabilities or what this repo can do. Let me summarize what I've found from reading the repo.

From the README.md, this is "Agents from First Principle and Scratch" - a project about understanding Pi's architecture. But the package.json shows this is "Kern — a minimal, from-first-principles terminal coding agent kernel".

The repo has these packages:
- agent-core - core agent logic
- cli - command line int

## user

what do you think about the current tui ? is it user friendly ?

## assistant




> thinking: The user is asking for my opinion on the current TUI (terminal user interface) and whether it's user-friendly. I need to look at the TUI code to understand its design and then give an informed opinion.

Let me first check the TUI package structure and source code.

```tool read
{
  "path": "packages/tui"
}
````

## tool

**tool result:**

- node_modules
- package.json
- src

## assistant




> thinking: Let me look at the TUI source code to understand its design.

```tool read
{
  "path": "packages/tui/src"
}
````
