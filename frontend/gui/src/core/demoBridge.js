// ==========================================================================
// IN-BROWSER TAP DEMO BRIDGE (Simulates the Go Desktop Bridge + TAP Server)
// Used for static GitHub Pages hosting so visitors can play without Go backend.
// ==========================================================================

(function () {
    const nativeFetch = window.fetch.bind(window);
    const streams = new Set();

    let worldCache = null;
    let session = null;

    const BOT_NAMES = {
        Lyra: { roomId: 'harbor_square' },
        Kael: { roomId: 'tavern' }
    };

    const BOT_REPLIES = [
        'Safe travels in Arvendale! Check the Blacksmith Forge west of Market Street for gear.',
        'Watch out for the Dire Wolf north of the Town Gate — bring Healing Elixirs!',
        'Captain Eliza on Harbor Square has a conspiracy quest if you feel brave.'
    ];

    async function loadWorldJson() {
        if (worldCache) return worldCache;
        const candidates = ['data/world.json', '../../data/world.json'];
        for (const url of candidates) {
            try {
                const res = await nativeFetch(url, { cache: 'no-store' });
                if (res.ok) {
                    worldCache = await res.json();
                    return worldCache;
                }
            } catch (_) {}
        }
        throw new Error('Could not load world.json');
    }

    function jsonResponse(obj, status = 200) {
        return new Response(JSON.stringify(obj), {
            status,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    function emitPacket(type, raw) {
        const payload = JSON.stringify({ type, raw });
        streams.forEach(es => {
            if (typeof es.onmessage === 'function') {
                es.onmessage({ data: payload });
            }
        });
    }

    function emitAsync(type, raw, delay = 15) {
        setTimeout(() => emitPacket(type, raw), delay);
    }

    // Mock EventSource for /api/stream
    const NativeEventSource = window.EventSource;
    window.EventSource = function (url) {
        if (!String(url).includes('/api/stream')) {
            return new NativeEventSource(url);
        }
        const es = {
            readyState: 1,
            onopen: null,
            onmessage: null,
            onerror: null,
            close() {
                this.readyState = 2;
                streams.delete(this);
            }
        };
        streams.add(es);
        setTimeout(() => {
            if (es.readyState === 1 && typeof es.onopen === 'function') {
                es.onopen({});
            }
        }, 15);
        return es;
    };

    function createFreshSession(username, worldDef) {
        const world = JSON.parse(JSON.stringify(worldDef));
        return {
            player: {
                name: username,
                roomId: 'harbor_square',
                hp: 100,
                maxHp: 100,
                baseAtk: 10,
                baseDef: 5,
                baseSpd: 10
            },
            world,
            inventory: {},
            quests: {},
            group: null,
            bots: JSON.parse(JSON.stringify(BOT_NAMES)),
            combat: null,
            combatCounter: 0
        };
    }

    function getStatusText(hp, maxHp) {
        if (hp <= 0) return 'dead';
        const pct = hp / maxHp;
        if (pct <= 0.25) return 'critical';
        if (pct <= 0.50) return 'wounded';
        if (pct <= 0.75) return 'injured';
        return 'healthy';
    }

    function getEffectivePlayerStats() {
        const p = session.player;
        let atk = p.baseAtk;
        let def = p.baseDef;
        let spd = p.baseSpd;

        Object.keys(session.inventory).forEach(itemId => {
            if ((session.inventory[itemId] || 0) <= 0) return;
            const item = session.world.items[itemId];
            if (!item) return;
            if (item.type === 'equipment' || item.type === 'unique') {
                atk += item.attack || 0;
                def += item.defense || 0;
                spd += item.speed || 0;
            }
        });
        return { atk, def, spd };
    }

    function getPlayersInRoom(roomId) {
        const list = [];
        if (session.player.roomId === roomId) list.push(session.player.name);
        Object.keys(session.bots).forEach(botName => {
            if (session.bots[botName].roomId === roomId) list.push(botName);
        });
        return list.sort();
    }

    function findItemInMap(itemMap, query) {
        const q = query.trim().toLowerCase();
        for (const id of Object.keys(itemMap)) {
            if ((itemMap[id] || 0) <= 0) continue;
            const item = session.world.items[id];
            if (!item) continue;
            if (id.toLowerCase() === q || item.name.toLowerCase() === q) {
                return id;
            }
        }
        return null;
    }

    function findNpcInRoom(room, query) {
        const q = query.trim().toLowerCase();
        for (const npcId of (room.npcs || [])) {
            const npc = session.world.npcs[npcId];
            if (!npc) continue;
            if (npcId.toLowerCase() === q || npc.name.toLowerCase() === q) {
                return npc;
            }
        }
        return null;
    }

    function addInventoryItem(itemId, qty = 1) {
        session.inventory[itemId] = (session.inventory[itemId] || 0) + qty;
    }

    function removeInventoryItem(itemId, qty = 1) {
        const cur = session.inventory[itemId] || 0;
        if (cur <= qty) {
            delete session.inventory[itemId];
        } else {
            session.inventory[itemId] = cur - qty;
        }
    }

    function resolveNpcQuest(npc) {
        if (!npc.quest_id) return null;

        let qId = npc.quest_id;
        const visited = new Set();

        while (qId && !visited.has(qId)) {
            visited.add(qId);
            const qDef = session.world.quests[qId];
            if (!qDef) break;

            let state = session.quests[qId];

            if (state === 'active') {
                const reqId = qDef.required_item_id;
                const reqQty = qDef.required_item_quantity || 1;
                const have = reqId ? (session.inventory[reqId] || 0) : 0;

                if (!reqId || have >= reqQty) {
                    if (reqId && qDef.consume_required_item) {
                        removeInventoryItem(reqId, reqQty);
                    }
                    (qDef.reward_item_ids || []).forEach(rId => addInventoryItem(rId, 1));
                    session.quests[qId] = 'completed';
                    state = 'completed';
                }
            }

            if (state === 'completed') {
                if (qDef.next_quest_id) {
                    qId = qDef.next_quest_id;
                    continue;
                }
                if (qDef.repeatable) {
                    session.quests[qId] = 'available';
                    state = 'available';
                }
            } else if (!state) {
                session.quests[qId] = 'available';
                state = 'available';
            }

            const reqId = qDef.required_item_id;
            const reqQty = qDef.required_item_quantity || 1;
            const have = Math.min(reqQty, reqId ? (session.inventory[reqId] || 0) : 0);
            const progress = state === 'active' && reqId ? `${have}/${reqQty}` : '';

            const qDlg = (npc.quest_dialogues && npc.quest_dialogues[qId]) || {};
            const lines = (qDlg[state] && qDlg[state].length > 0)
                ? qDlg[state]
                : (npc.dialogue && npc.dialogue.default) || ['Greetings, traveler.'];

            return {
                quest: {
                    id: qDef.id,
                    name: qDef.name,
                    description: qDef.description,
                    progress
                },
                quest_status: state,
                dialogue: lines
            };
        }

        return null;
    }

    function executeCommand(rawCmd) {
        if (!session) {
            emitAsync('ERR', 'ERR 403 CONNECT_REQUIRED');
            return;
        }

        const trimmed = rawCmd.trim();
        if (!trimmed) {
            emitAsync('ERR', 'ERR 400 INVALID_REQUEST');
            return;
        }

        const firstSpace = trimmed.search(/\s/);
        const verb = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toUpperCase();
        const rawArgs = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
        const args = rawArgs ? rawArgs.split(/\s+/) : [];
        const room = session.world.rooms[session.player.roomId];

        switch (verb) {
            case 'QUIT': {
                session = null;
                emitAsync('OK', 'OK bye');
                return;
            }

            case 'WHO': {
                const count = 1 + Object.keys(session.bots).length;
                emitAsync('OK', `OK players=${count}`);
                return;
            }

            case 'STATUS': {
                const p = session.player;
                emitAsync('OK', 'OK ' + JSON.stringify({
                    hp: p.hp,
                    max_hp: p.maxHp,
                    status: getStatusText(p.hp, p.maxHp)
                }));
                return;
            }

            case 'LOOK': {
                const items = [];
                Object.keys(room.items || {}).forEach(id => {
                    const qty = room.items[id] || 0;
                    const def = session.world.items[id];
                    if (!def || qty <= 0) return;
                    for (let i = 0; i < qty; i++) items.push(def);
                });

                const npcs = (room.npcs || []).map(id => {
                    const n = session.world.npcs[id];
                    return {
                        id: n.id,
                        name: n.name,
                        role: n.role,
                        hostile: !!n.hostile,
                        combat_stats: n.combat_stats
                    };
                });

                emitAsync('OK', 'OK ' + JSON.stringify({
                    room,
                    players: getPlayersInRoom(room.id),
                    items,
                    npcs
                }));
                return;
            }

            case 'MOVE': {
                if (session.combat) {
                    emitAsync('ERR', 'ERR 409 PLAYER_ALREADY_IN_COMBAT');
                    return;
                }
                const dir = (args[0] || '').toLowerCase();
                const dest = room.exits && room.exits[dir];
                if (!dest || !session.world.rooms[dest]) {
                    emitAsync('ERR', 'ERR 301 NO_EXIT');
                    return;
                }
                session.player.roomId = dest;
                emitAsync('OK', `OK room=${dest}`);
                return;
            }

            case 'TAKE': {
                if (session.combat) {
                    emitAsync('ERR', 'ERR 409 PLAYER_ALREADY_IN_COMBAT');
                    return;
                }
                if (!rawArgs) {
                    emitAsync('ERR', 'ERR 400 ITEM_REQUIRED');
                    return;
                }
                const itemId = findItemInMap(room.items || {}, rawArgs);
                if (!itemId) {
                    emitAsync('ERR', 'ERR 404 ITEM_NOT_FOUND');
                    return;
                }
                if ((session.inventory[itemId] || 0) > 0) {
                    emitAsync('ERR', 'ERR 413 ITEM_ALREADY_OWNED');
                    return;
                }
                room.items[itemId] -= 1;
                if (room.items[itemId] <= 0) delete room.items[itemId];
                addInventoryItem(itemId, 1);
                emitAsync('OK', `OK taken=${itemId}`);
                return;
            }

            case 'DROP': {
                if (session.combat) {
                    emitAsync('ERR', 'ERR 409 PLAYER_ALREADY_IN_COMBAT');
                    return;
                }
                if (!rawArgs) {
                    emitAsync('ERR', 'ERR 400 ITEM_REQUIRED');
                    return;
                }
                const itemId = findItemInMap(session.inventory, rawArgs);
                if (!itemId) {
                    emitAsync('ERR', 'ERR 411 ITEM_NOT_IN_INVENTORY');
                    return;
                }
                const def = session.world.items[itemId];
                if (def.type !== 'common' && def.type !== 'consumable') {
                    emitAsync('ERR', 'ERR 412 ITEM_CANNOT_BE_DROPPED');
                    return;
                }
                removeInventoryItem(itemId, 1);
                room.items = room.items || {};
                room.items[itemId] = (room.items[itemId] || 0) + 1;
                emitAsync('OK', `OK dropped=${itemId}`);
                return;
            }

            case 'USE': {
                if (session.combat) {
                    emitAsync('ERR', 'ERR 409 PLAYER_ALREADY_IN_COMBAT');
                    return;
                }
                handleUseItem(rawArgs);
                return;
            }

            case 'INVENTORY': {
                const list = Object.keys(session.inventory).map(id => ({
                    id,
                    quantity: session.inventory[id]
                }));
                emitAsync('OK', 'OK ' + JSON.stringify(list));
                return;
            }

            case 'TALK': {
                if (session.combat) {
                    emitAsync('ERR', 'ERR 409 PLAYER_ALREADY_IN_COMBAT');
                    return;
                }
                const npc = findNpcInRoom(room, rawArgs);
                if (!npc) {
                    emitAsync('ERR', 'ERR 414 NPC_NOT_FOUND');
                    return;
                }
                const npcSummary = {
                    id: npc.id,
                    name: npc.name,
                    role: npc.role,
                    hostile: !!npc.hostile,
                    combat_stats: npc.combat_stats
                };
                const qInfo = resolveNpcQuest(npc);
                if (qInfo) {
                    emitAsync('OK', 'OK ' + JSON.stringify({
                        npc: npcSummary,
                        dialogue: qInfo.dialogue,
                        quest: qInfo.quest,
                        quest_status: qInfo.quest_status
                    }));
                } else {
                    emitAsync('OK', 'OK ' + JSON.stringify({
                        npc: npcSummary,
                        dialogue: (npc.dialogue && npc.dialogue.default) || ['Greetings, adventurer.']
                    }));
                }
                return;
            }

            case 'QUEST': {
                if (session.combat) {
                    emitAsync('ERR', 'ERR 409 PLAYER_ALREADY_IN_COMBAT');
                    return;
                }
                const npc = findNpcInRoom(room, rawArgs);
                if (!npc) {
                    emitAsync('ERR', 'ERR 414 NPC_NOT_FOUND');
                    return;
                }
                const qInfo = resolveNpcQuest(npc);
                if (!qInfo || qInfo.quest_status !== 'available') {
                    emitAsync('ERR', 'ERR 406 NO_QUEST_AVAILABLE');
                    return;
                }
                session.quests[qInfo.quest.id] = 'active';
                emitAsync('OK', 'OK ' + JSON.stringify({
                    id: qInfo.quest.id,
                    name: qInfo.quest.name,
                    description: qInfo.quest.description
                }));
                return;
            }

            case 'QUESTS': {
                const list = [];
                Object.keys(session.quests).forEach(qId => {
                    const status = session.quests[qId];
                    if (status !== 'active' && status !== 'completed') return;
                    const qDef = session.world.quests[qId];
                    if (!qDef) return;
                    let progress = '';
                    if (status === 'active' && qDef.required_item_id) {
                        const reqQty = qDef.required_item_quantity || 1;
                        const have = Math.min(reqQty, session.inventory[qDef.required_item_id] || 0);
                        progress = `${have}/${reqQty}`;
                    }
                    list.push({
                        id: qDef.id,
                        name: qDef.name,
                        description: qDef.description,
                        status,
                        progress
                    });
                });
                emitAsync('OK', 'OK ' + JSON.stringify(list));
                return;
            }

            case 'CHAT': {
                const scope = (args[0] || '').toUpperCase();
                const msg = args.slice(1).join(' ');
                if (!msg || !['GLOBAL', 'ROOM', 'GROUP'].includes(scope)) {
                    emitAsync('ERR', 'ERR 422 INVALID_ARGUMENTS');
                    return;
                }
                if (scope === 'GROUP' && !session.group) {
                    emitAsync('ERR', 'ERR 401 NOT_IN_GROUP');
                    return;
                }
                emitAsync('OK', 'OK');
                emitAsync('EVT', `EVT ${scope} CHAT player=${session.player.name} message=${msg}`, 30);

                // Friendly bot reply in demo mode
                if (!msg.includes('[COMBAT_ID:')) {
                    const roomBots = Object.keys(session.bots).filter(b => session.bots[b].roomId === room.id);
                    const replyBot = scope === 'GROUP' && session.group
                        ? session.group.Members.find(m => session.bots[m])
                        : (roomBots[0] || (scope === 'GLOBAL' ? 'Lyra' : null));
                    if (replyBot) {
                        const reply = BOT_REPLIES[Math.floor(Math.random() * BOT_REPLIES.length)];
                        emitAsync('EVT', `EVT ${scope} CHAT player=${replyBot} message=${reply}`, 900);
                    }
                }
                return;
            }

            case 'GROUP': {
                handleGroup(args);
                return;
            }

            case 'ATTACK': {
                handleStartCombat(rawArgs, room);
                return;
            }

            case 'COMBAT': {
                handleCombatAction(args);
                return;
            }

            default:
                emitAsync('ERR', 'ERR 408 UNKNOWN_COMMAND');
        }
    }

    function handleUseItem(query) {
        if (!query) {
            emitAsync('ERR', 'ERR 400 ITEM_REQUIRED');
            return;
        }
        const itemId = findItemInMap(session.inventory, query);
        if (!itemId) {
            emitAsync('ERR', 'ERR 411 ITEM_NOT_IN_INVENTORY');
            return;
        }
        const def = session.world.items[itemId];
        if (def.type !== 'consumable' || !def.hp) {
            emitAsync('ERR', 'ERR 409 ITEM_NOT_CONSUMABLE');
            return;
        }
        const p = session.player;
        if (p.hp >= p.maxHp) {
            emitAsync('ERR', 'ERR 409 ITEM_HAS_NO_EFFECT');
            return;
        }
        const newHp = Math.min(p.maxHp, p.hp + def.hp);
        const healed = newHp - p.hp;
        p.hp = newHp;
        removeInventoryItem(itemId, 1);
        emitAsync('OK', `OK used=${itemId} hp=${healed}`);
    }

    function handleGroup(args) {
        const sub = (args[0] || '').toUpperCase();
        if (sub === 'CREATE') {
            if (session.group) {
                emitAsync('ERR', 'ERR 402 ALREADY_IN_GROUP');
                return;
            }
            const name = args.slice(1).join(' ').trim();
            if (!name) {
                emitAsync('ERR', 'ERR 422 INVALID_ARGUMENTS');
                return;
            }
            session.group = {
                ID: 'group:1',
                Name: name,
                Members: [session.player.name],
                Invitations: {}
            };
            emitAsync('OK', `OK group=group:1 name=${name}`);
            return;
        }
        if (sub === 'INFO') {
            if (!session.group) {
                emitAsync('ERR', 'ERR 401 NOT_IN_GROUP');
                return;
            }
            emitAsync('OK', 'OK ' + JSON.stringify(session.group));
            return;
        }
        if (sub === 'INVITATIONS') {
            emitAsync('OK', 'OK []');
            return;
        }
        if (sub === 'LEAVE') {
            if (!session.group) {
                emitAsync('ERR', 'ERR 401 NOT_IN_GROUP');
                return;
            }
            session.group = null;
            emitAsync('OK', 'OK');
            return;
        }
        if (sub === 'INVITE') {
            if (!session.group) {
                emitAsync('ERR', 'ERR 401 NOT_IN_GROUP');
                return;
            }
            const target = args[1] || '';
            const botName = Object.keys(session.bots).find(b => b.toLowerCase() === target.toLowerCase());
            if (!botName) {
                emitAsync('ERR', 'ERR 409 COMMAND_FAILED');
                return;
            }
            emitAsync('OK', 'OK');
            if (!session.group.Members.includes(botName)) {
                setTimeout(() => {
                    if (session && session.group) {
                        session.group.Members.push(botName);
                        emitPacket('EVT', `EVT GROUP JOIN player=${botName}`);
                        emitPacket('EVT', `EVT GROUP CHAT player=${botName} message=Joined the party! Ready for adventure.`);
                    }
                }, 800);
            }
            return;
        }
        emitAsync('ERR', 'ERR 409 COMMAND_FAILED');
    }

    function handleStartCombat(targetQuery, room) {
        if (session.combat) {
            emitAsync('ERR', 'ERR 409 PLAYER_ALREADY_IN_COMBAT');
            return;
        }
        const npc = findNpcInRoom(room, targetQuery);
        if (!npc) {
            emitAsync('ERR', 'ERR 414 NPC_NOT_FOUND');
            return;
        }
        if (!npc.hostile) {
            emitAsync('ERR', 'ERR 405 NPC_NOT_HOSTILE');
            return;
        }
        if (npc._respawnAt && Date.now() < npc._respawnAt) {
            emitAsync('ERR', 'ERR 415 NPC_RESPAWNING');
            return;
        }
        npc._respawnAt = 0;

        session.combatCounter += 1;
        const combatId = `combat:${session.combatCounter}`;
        const maxHp = npc.combat_stats.max_hp || npc.combat_stats.hp || 45;
        session.combat = {
            id: combatId,
            npcId: npc.id,
            npcName: npc.name,
            npcHp: maxHp,
            npcMaxHp: maxHp,
            npcAtk: npc.combat_stats.attack || 10,
            npcDef: npc.combat_stats.defense || 4,
            defending: false,
            round: 1
        };

        emitAsync('OK', 'OK ' + JSON.stringify({
            combat_id: combatId,
            attacker_hp: session.player.hp,
            target_hp: maxHp,
            damage: 0,
            status: 'combat'
        }), 15);
        emitAsync('EVT', `EVT COMBAT STARTED combat=${combatId} room=${room.id} participants=${session.player.name}`, 25);
        emitAsync('EVT', `EVT COMBAT TURN participant_type=PLAYER participant=${session.player.name} round=1 actions=1`, 35);
    }

    function runNpcCounterAttack(c) {
        const p = session.player;
        const stats = getEffectivePlayerStats();
        const effDef = c.defending ? Math.floor(stats.def * 1.5) : stats.def;
        const npcDmg = Math.max(1, c.npcAtk - effDef);

        p.hp = Math.max(0, p.hp - npcDmg);
        c.defending = false;

        emitAsync('EVT', `EVT COMBAT TURN participant_type=NPC participant=${c.npcName} round=${c.round} actions=1`, 40);
        emitAsync('EVT', `EVT COMBAT DAMAGE attacker=${c.npcName} target=${p.name} amount=${npcDmg} remaining_hp=${p.hp}`, 55);

        if (p.hp <= 0) {
            p.roomId = 'harbor_square';
            p.hp = Math.floor(p.maxHp / 4);
            session.combat = null;
            emitAsync('EVT', `EVT COMBAT PLAYER_DIED participant=${p.name} killer=${c.npcName}`, 75);
            emitAsync('EVT', `EVT COMBAT ENDED combat=${c.id} rewards=[]`, 85);
            return;
        }

        c.round += 1;
        emitAsync('EVT', `EVT COMBAT TURN participant_type=PLAYER participant=${p.name} round=${c.round} actions=1`, 75);
    }

    function handleCombatAction(args) {
        const c = session.combat;
        if (!c) {
            emitAsync('ERR', 'ERR 409 NOT_IN_COMBAT');
            return;
        }
        const sub = (args[0] || '').toUpperCase();
        const p = session.player;

        if (sub === 'ATTACK') {
            const stats = getEffectivePlayerStats();
            const dmg = Math.max(1, stats.atk - c.npcDef);
            c.npcHp = Math.max(0, c.npcHp - dmg);

            emitAsync('EVT', `EVT COMBAT DAMAGE attacker=${p.name} target=${c.npcName} amount=${dmg} remaining_hp=${c.npcHp}`, 15);

            if (c.npcHp <= 0) {
                const npc = session.world.npcs[c.npcId];
                const respSec = (npc && npc.respawn_seconds) || 45;
                if (npc) npc._respawnAt = Date.now() + respSec * 1000;
                const rewards = (npc && npc.rewards) || [];
                rewards.forEach(rId => addInventoryItem(rId, 1));
                session.combat = null;

                emitAsync('EVT', `EVT COMBAT NPC_DIED participant=${c.npcName} killer=${p.name}`, 35);
                emitAsync('EVT', `EVT COMBAT ENDED combat=${c.id} rewards=[]`, 45);
                emitAsync('OK', `OK target=${c.npcId} damage=${dmg} combat=${c.id}`, 55);
                return;
            }

            runNpcCounterAttack(c);
            emitAsync('OK', `OK target=${c.npcId} damage=${dmg} combat=${c.id}`, 90);
            return;
        }

        if (sub === 'DEFEND') {
            c.defending = true;
            runNpcCounterAttack(c);
            emitAsync('OK', `OK defended=true defense_bonus=50 combat=${c.id}`, 90);
            return;
        }

        if (sub === 'USE') {
            handleUseItem(args.slice(1).join(' '));
            return;
        }

        if (sub === 'HELP') {
            emitAsync('OK', `OK help_requested=true combat=${c.id}`);
            return;
        }

        if (sub === 'FLEE') {
            const rawPen = Math.floor((p.hp * 15) / 100);
            const pen = Math.min(Math.max(0, p.hp - 1), Math.max(1, rawPen));
            p.hp = Math.max(1, p.hp - pen);
            const cid = c.id;
            session.combat = null;
            emitAsync('OK', `OK fled=true damage=${pen} hp=${p.hp} combat=${cid}`);
            return;
        }

        emitAsync('ERR', 'ERR 422 INVALID_ARGUMENTS');
    }

    // Intercept /api/* fetch calls
    window.fetch = async function (input, init = {}) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';

        if (url.endsWith('/api/config')) {
            return jsonResponse({ host: 'demo.arvendale.web', port: '8090' });
        }

        if (url.endsWith('/api/world')) {
            const worldDef = await loadWorldJson();
            return jsonResponse(worldDef);
        }

        if (url.endsWith('/api/session')) {
            return jsonResponse({
                connected: !!session,
                username: session ? session.player.name : ''
            });
        }

        if (url.endsWith('/api/connect')) {
            const body = JSON.parse(init.body || '{}');
            const username = String(body.username || '').trim();
            if (!username || username.length > 12 || /\s/.test(username)) {
                return jsonResponse({ status: 'ERR', error: 'ERR 407 INVALID_USERNAME' });
            }
            const worldDef = await loadWorldJson();
            session = createFreshSession(username, worldDef);

            emitAsync('EVT', `EVT STATS players=${1 + Object.keys(session.bots).length}`, 80);
            setTimeout(() => {
                if (session) {
                    emitPacket('EVT', `EVT ROOM CHAT player=Lyra message=Welcome to Arvendale, ${username}! Speak with Captain Eliza or explore north to Market Street.`);
                }
            }, 900);

            return jsonResponse({ status: 'OK', username, message: 'OK connected' });
        }

        if (url.endsWith('/api/command')) {
            const body = JSON.parse(init.body || '{}');
            executeCommand(String(body.command || ''));
            return jsonResponse({ status: 'OK' });
        }

        return nativeFetch(input, init);
    };

    // Update login labels slightly so visitors know it runs directly in browser
    document.addEventListener('DOMContentLoaded', () => {
        const hint = document.querySelector('.login-hint');
        if (hint) {
            hint.textContent = 'Interactive Browser Demo (Simulated TAP Server) — choose a name and click Connect!';
        }
        const hostInput = document.getElementById('login-host');
        const portInput = document.getElementById('login-port');
        if (hostInput) hostInput.readOnly = true;
        if (portInput) portInput.readOnly = true;
    });
})();