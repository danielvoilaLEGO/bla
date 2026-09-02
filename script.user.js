// ==UserScript==
// @name         ALH Semi-Auto
// @namespace    http://tampermonkey.net/
// @version      90.3
// @description  Semi-auto flow: searches tickets + selects hour, stops at details for manual fill
// @match        https://compratickets.alhambra-patronato.es/reservarEntradas.aspx*
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @grant        window.close
// @connect      2captcha.com
// @connect      firestore.googleapis.com
// @connect      ntfy.sh
// @connect      api.openinbox.io
// ==/UserScript==

(function () {
    'use strict';

    let autoFlow = sessionStorage.getItem("autoFlow") === "true";
    let dateValue = sessionStorage.getItem("dateValue") || "";
    let numTickets = sessionStorage.getItem("numTickets") || "1";
    let apiKey2Captcha = "55a718515ab2ad73174833daecbd5366";
    let captchaSolved = sessionStorage.getItem("captchaSolved") === "true";
    let ticketsAdded = sessionStorage.getItem("ticketsAdded") === "true";
    let manualCaptcha = sessionStorage.getItem("manualCaptcha") === "false";
    let manualEmail = sessionStorage.getItem("manualEmail") === "true";
    let numTeenTickets = sessionStorage.getItem("numTeenTickets") || "0";
    let numChildTickets = sessionStorage.getItem("numChildTickets") || "0";
    let manualCaptchaResolver = null;
    let manualEmailResolver = null;
    let selectedSlot = sessionStorage.getItem("selectedSlot") || "";
    let firebaseFetched = sessionStorage.getItem("firebaseFetched") === "true";
    let sessionStopwatchStart = parseInt(sessionStorage.getItem("sessionStopwatchStart"), 10) || 0;
    const SESSION_TIMEOUT_MS = 27 * 60 * 1000;
    let running = false;
        let excludedDates = [];
    try {
        const storedExcl = sessionStorage.getItem("excludedDates");
        if (storedExcl) excludedDates = JSON.parse(storedExcl);
    } catch(e) {}
    let findBestSlot = sessionStorage.getItem("findBestSlot") !== "false";
    let bestSlotRank = parseInt(sessionStorage.getItem("bestSlotRank"), 10) || 1;
    let preferredTime = sessionStorage.getItem("preferredTime") || "";
    let emailVerified = sessionStorage.getItem("emailVerified") === "true";
    const OPENINBOX_API_KEY = "tmp_839cf0f3550744fe8505c23e0d9f16d7";
    let chosenEmail = sessionStorage.getItem("chosenEmail") || "";
    let chosenEmailAddressId = sessionStorage.getItem("chosenEmailAddressId") || "";

    // --- Buffered log intercept ---
    const _alhLogBuffer = [];
    const _origLog = console.log.bind(console);
    console.log = (...args) => {
        _origLog(...args);
        const msg = args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
        const now = new Date();
        const ts = now.toTimeString().slice(0, 8);
        const logDiv = document.getElementById("alhLog");
        if (logDiv) {
            const line = document.createElement("div");
            line.textContent = `[${ts}] ${msg}`;
            logDiv.appendChild(line);
            logDiv.scrollTop = logDiv.scrollHeight;
        } else {
            _alhLogBuffer.push(`[${ts}] ${msg}`);
        }
    };

    const FIREBASE_API_KEY = "AIzaSyBniZTfD3dGs8EzNfqLy956djUwMlCsRYo";
    const FIREBASE_PROJECT_ID = "alh-tickets";
    const FIREBASE_COLLECTION = "tickets";

    let firebaseDocId = sessionStorage.getItem("firebaseDocId") || "";
    let firebaseDetails = [];
    try {
        const stored = sessionStorage.getItem("ticketHolders");
        if (stored) firebaseDetails = JSON.parse(stored);
    } catch(e) {}

    console.log("=== Semi-Auto Script initialized ===");
    console.log("autoFlow:", autoFlow);
    console.log("dateValue:", dateValue);
    console.log("numTickets:", numTickets);
    console.log("captchaSolved:", captchaSolved);
    console.log("ticketsAdded:", ticketsAdded);
    console.log("====================================");

    // --- Keep tab alive in background (prevents Chrome timer throttling) ---
    let _keepAliveCtx = null;
    function keepTabAlive() {
        if (_keepAliveCtx) return; // already running
        try {
            _keepAliveCtx = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = _keepAliveCtx.createOscillator();
            const gain = _keepAliveCtx.createGain();
            gain.gain.value = 0.001; // virtually silent
            oscillator.connect(gain);
            gain.connect(_keepAliveCtx.destination);
            oscillator.start();
            console.log("KeepAlive: Silent audio started — tab will stay active in background");
        } catch (e) {
            console.log("KeepAlive: Could not start AudioContext:", e);
        }
    }

    // --- Wait for element utility ---
    function waitForElement(selector, timeout = 15000) {
        return new Promise((resolve, reject) => {
            const el = document.querySelector(selector);
            if (el) return resolve(el);
            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    observer.disconnect();
                    resolve(el);
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => {
                observer.disconnect();
                reject("Timeout waiting for " + selector);
            }, timeout);
        });
    }

    // --- Solve reCAPTCHA using 2captcha API ---
    async function solve2Captcha() {
        if (!apiKey2Captcha) {
            console.log("AutoFlow: No 2captcha API key set. Waiting for manual solve...");
            return null;
        }
        console.log("AutoFlow: Solving captcha using 2captcha API...");
        const siteKey = "6LfXS2IUAAAAADr2WUPQDzAnTEbSQzE1Jxh0Zi0a";
        const pageUrl = window.location.href;
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: `https://2captcha.com/in.php?key=${apiKey2Captcha}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`,
                onload: (response) => {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data.status === 1) {
                            const taskId = data.request;
                            console.log("AutoFlow: Captcha task submitted, ID:", taskId);
                            let attempts = 0;
                            const maxAttempts = 150;
                            const checkResult = () => {
                                attempts++;
                                console.log(`AutoFlow: Checking captcha result (attempt ${attempts}/${maxAttempts})...`);
                                GM_xmlhttpRequest({
                                    method: "GET",
                                    url: `https://2captcha.com/res.php?key=${apiKey2Captcha}&action=get&id=${taskId}&json=1`,
                                    onload: (checkResponse) => {
                                        try {
                                            const checkData = JSON.parse(checkResponse.responseText);
                                            if (checkData.status === 1) {
                                                console.log("AutoFlow: Captcha solved successfully!");
                                                resolve(checkData.request);
                                            } else if (checkData.request === "CAPCHA_NOT_READY") {
                                                if (attempts < maxAttempts) {
                                                    setTimeout(checkResult, 2000);
                                                } else {
                                                    console.log("AutoFlow: Captcha solving timeout");
                                                    resolve(null);
                                                }
                                            } else {
                                                console.log("AutoFlow: Captcha error:", checkData.request);
                                                resolve(null);
                                            }
                                        } catch (e) {
                                            console.log("AutoFlow: Error parsing captcha result:", e);
                                            resolve(null);
                                        }
                                    },
                                    onerror: () => {
                                        console.log("AutoFlow: Network error checking captcha");
                                        resolve(null);
                                    }
                                });
                            };
                            setTimeout(checkResult, 5000);
                        } else {
                            console.log("AutoFlow: Error submitting captcha:", data.request);
                            resolve(null);
                        }
                    } catch (e) {
                        console.log("AutoFlow: Error parsing captcha submission:", e);
                        resolve(null);
                    }
                },
                onerror: () => {
                    console.log("AutoFlow: Network error submitting captcha");
                    resolve(null);
                }
            });
        });
    }

    // --- Wait for captcha to be solved (manual or auto) ---
    async function waitForCaptchaSolved(maxWaitSeconds = 180) {
        console.log("AutoFlow: Waiting for captcha to be solved...");
        const startTime = Date.now();
        while ((Date.now() - startTime) / 1000 < maxWaitSeconds) {
            if (typeof grecaptcha !== 'undefined' && grecaptcha.getResponse && grecaptcha.getResponse().length > 0) {
                console.log("AutoFlow: Captcha already solved!");
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        console.log("AutoFlow: Captcha wait timeout");
        return false;
    }

    // --- Add tickets by button ID ---
    async function addTickets(targetCount, btnPlusId) {
        console.log(`AutoFlow: Target count: ${targetCount}`);
        const ticketsToAdd = targetCount;
        if (ticketsToAdd <= 0) {
            console.log(`AutoFlow: No tickets to add (target: ${targetCount})`);
            return true;
        }
        console.log(`AutoFlow: Need to add ${ticketsToAdd} more (target: ${targetCount})`);
        for (let i = 0; i < ticketsToAdd; i++) {
            console.log(`AutoFlow: Adding ticket ${i + 1} of ${ticketsToAdd}`);
            await new Promise(resolve => setTimeout(resolve, 500));
            const ticketBtn = document.getElementById(btnPlusId);
            if (ticketBtn) {
                ticketBtn.click();
                console.log(`AutoFlow: Waiting 3 second after ticket click...`);
                await new Promise(resolve => setTimeout(resolve, 3000));
            } else {
                console.log(`AutoFlow: Ticket button not found: ${btnPlusId}`);
                return false;
            }
        }
        console.log("AutoFlow: All tickets added successfully");
        return true;
    }

    const TICKET_TYPES = [
        {
            label: "Adult",
            btnId: "ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_rptGruposEntradas_ctl00_rptEntradas_ctl00_btnMas2",
            getCount: () => parseInt(numTickets, 10) || 0,
        },
        {
            label: "Teen",
            btnId: "ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_rptGruposEntradas_ctl00_rptEntradas_ctl01_btnMas2",
            getCount: () => parseInt(numTeenTickets, 10) || 0,
        },
        {
            label: "Child",
            btnId: "ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_rptGruposEntradas_ctl00_rptEntradas_ctl02_btnMas2",
            getCount: () => parseInt(numChildTickets, 10) || 0,
        },
    ];

    // --- Ask user for Firebase document ID ---
    function fetchDocList() {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${FIREBASE_COLLECTION}?key=${FIREBASE_API_KEY}`,
                onload: (response) => {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (!data.documents || !Array.isArray(data.documents)) {
                            console.log("DocList: No documents found");
                            resolve([]);
                            return;
                        }
                        const docs = data.documents.map(doc => {
                            const id = doc.name.split("/").pop();
                            const dayField = doc.fields && doc.fields.day;
                            const day = dayField ? Number(dayField.integerValue || dayField.stringValue || dayField.doubleValue || 0) : 0;
                            return { id, day };
                        }).sort((a, b) => a.id.localeCompare(b.id));
                        console.log("DocList: Found", docs.length, "documents");
                        resolve(docs);
                    } catch (e) {
                        console.log("DocList: Parse error:", e);
                        resolve([]);
                    }
                },
                onerror: () => {
                    console.log("DocList: Network error");
                    resolve([]);
                }
            });
        });
    }

    function askForDocId() {
        return new Promise(async (resolve) => {
            const overlay = document.createElement("div");
            overlay.id = "alhambraDocIdOverlay";
            Object.assign(overlay.style, {
                position: "fixed", top: "0", left: "0",
                width: "100%", height: "100%",
                background: "rgba(0,0,0,0.75)",
                zIndex: "9999999",
                display: "flex", alignItems: "center", justifyContent: "center"
            });

            overlay.innerHTML = `
                <div style="background:#1f2933;color:white;padding:clamp(36px,6vw,72px);border-radius:24px;font-family:Arial;width:clamp(600px,80vw,1400px);max-width:95vw;text-align:center;box-sizing:border-box">
                    <div style="font-weight:bold;font-size:clamp(42px,6vw,72px);margin-bottom:clamp(20px,3vw,40px)">Alhambra Booking</div>
                    <div style="font-size:clamp(24px,3vw,42px);color:#aaa;margin-bottom:clamp(16px,2vw,32px)">Pick a booking</div>
                    <div id="alhPresetContainer" style="display:flex;flex-wrap:wrap;gap:clamp(12px,1.5vw,24px);justify-content:center;margin-bottom:clamp(28px,4vw,56px)">
                        <div style="color:#888;font-size:clamp(22px,3vw,40px)">Loading...</div>
                    </div>
                    <div style="font-size:clamp(18px,2vw,30px);color:#666;margin-bottom:clamp(12px,1.5vw,24px)">— or type a custom ID —</div>
                    <div style="display:flex;gap:clamp(12px,1.5vw,24px);align-items:center">
                        <input id="inputDocId" type="text" placeholder="e.g. Moritz"
                               style="flex:1;padding:clamp(18px,2.5vw,36px);box-sizing:border-box;font-size:clamp(28px,4vw,52px);border-radius:12px;border:3px solid #555;background:#111;color:white" />
                        <button id="btnDocIdOk" style="background:#27ae60;color:white;border:none;padding:clamp(18px,2.5vw,36px) clamp(40px,5vw,80px);border-radius:12px;cursor:pointer;font-size:clamp(28px,4vw,52px);font-weight:bold">OK</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const pick = (val) => { overlay.remove(); resolve(val); };

            const input = overlay.querySelector("#inputDocId");
            input.focus();
            overlay.querySelector("#btnDocIdOk").onclick = () => {
                const val = input.value.trim();
                if (val) pick(val);
            };
            input.addEventListener("keydown", (e) => { if (e.key === "Enter") { const val = input.value.trim(); if (val) pick(val); } });

            const allDocs = await fetchDocList();
            const now = new Date();
            const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
            const jan1_2000 = new Date(2000, 0, 1);
            const tomorrowDayValue = Math.round((tomorrow - jan1_2000) / 86400000);
            const docIds = allDocs.filter(d => d.day === tomorrowDayValue);
            console.log("DocList: tomorrow dayValue=", tomorrowDayValue, "(", tomorrow.toLocaleDateString(), "), showing", docIds.length, "of", allDocs.length, "docs");
            const container = overlay.querySelector("#alhPresetContainer");
            if (docIds.length === 0) {
                container.innerHTML = `<div style="color:#ff6666;font-size:clamp(22px,3vw,40px)">No upcoming documents found</div>`;
            } else {
                container.innerHTML = docIds.map(d =>
                    `<button class="alhPreset" data-val="${d.id}" style="background:#2980b9;color:white;border:none;padding:clamp(8px,1vw,14px) clamp(14px,1.5vw,24px);border-radius:8px;cursor:pointer;font-size:clamp(16px,2vw,28px);font-weight:bold;transition:filter 0.1s,transform 0.1s">${d.id}</button>`
                ).join("");
                container.querySelectorAll(".alhPreset").forEach(btn => {
                    btn.onmouseenter = () => { btn.style.filter = "brightness(1.3)"; };
                    btn.onmouseleave = () => { btn.style.filter = ""; };
                    btn.onclick = () => pick(btn.dataset.val);
                });
            }
        });
    }

    // --- Fetch 'day' and 'details' from Firestore ---
    async function fetchFirebaseData(docId) {
        console.log("Firebase: Fetching document:", docId);
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${FIREBASE_COLLECTION}/${docId}?key=${FIREBASE_API_KEY}`,
                onload: (response) => {
                    try {
                        const data = JSON.parse(response.responseText);
                        const result = { day: null, ticketHolders: [], findBestSlot: true, bestSlotRank: 1, preferredTime: "" };
                        if (data.error || !data.fields) {
                            console.log("Firebase: Document not found or error:", (data.error && data.error.message) || "no fields returned");
                            resolve({ day: null, ticketHolders: [], error: true });
                            return;
                        }
                        const dayField = data.fields.day;
                        if (dayField) {
                            result.day = String(dayField.integerValue || dayField.doubleValue || dayField.stringValue);
                            console.log("Firebase: Got day:", result.day);
                        } else {
                            console.log("Firebase: 'day' field not found");
                        }
                        const detailsField = data.fields.details;
                        if (detailsField && detailsField.stringValue) {
                            try {
                                const details = JSON.parse(detailsField.stringValue);
                                if (Array.isArray(details.ticketHolders)) {
                                    result.ticketHolders = details.ticketHolders.map(h => ({
                                        firstName:   h.firstName,
                                        lastName:    h.lastName,
                                        idNumber:    h.idNumber,
                                        countryCode: h.countryCode,
                                        age:         h.age
                                    }));
                                    console.log("Firebase: Got", result.ticketHolders.length, "ticket holders");
                                }
                                if (typeof details.findBestSlot === "boolean") {
                                    result.findBestSlot = details.findBestSlot;
                                }
                                if (typeof details.bestSlotRank === "number" && details.bestSlotRank >= 1) {
                                    result.bestSlotRank = details.bestSlotRank;
                                }
                                if (typeof details.preferredTime === "string" && details.preferredTime) {
                                    result.preferredTime = details.preferredTime;
                                }
                                console.log(`Firebase: findBestSlot=${result.findBestSlot}, bestSlotRank=${result.bestSlotRank}, preferredTime=${result.preferredTime || "none"}`);
                            } catch (e) {
                                console.log("Firebase: Error parsing details JSON:", e);
                            }
                        } else {
                            console.log("Firebase: 'details' field not found");
                        }
                        resolve(result);
                    } catch (e) {
                        console.log("Firebase: Error parsing response:", e);
                        resolve({ day: null, ticketHolders: [], error: true });
                    }
                },
                onerror: () => {
                    console.log("Firebase: Network error");
                    resolve({ day: null, ticketHolders: [], error: true });
                }
            });
        });
    }

    // --- Dismiss cookie banner if present ---
    async function dismissCookieBanner() {
        const cookieBtn = document.getElementById("ctl00_lnkAceptarTodoCookies_Info");
        if (cookieBtn) {
            console.log("Cookies: Banner found, dismissing...");
            cookieBtn.click();
            console.log("Cookies: Dismissed");
        }
    }

    // --- Clear all cookies for the domain (tries multiple methods) ---
    async function clearAllCookies() {
        let totalDeleted = 0;

        // Method 1: GM_cookie (can delete HttpOnly cookies if enabled in Tampermonkey settings)
        if (typeof GM_cookie !== "undefined" && GM_cookie.list) {
            try {
                const gmDeleted = await new Promise((resolve) => {
                    GM_cookie.list({ url: window.location.href }, (cookies, error) => {
                        if (error || !cookies || cookies.length === 0) {
                            console.log("ClearCookies [GM_cookie]: No cookies or error:", error);
                            resolve(0);
                            return;
                        }
                        console.log(`ClearCookies [GM_cookie]: Found ${cookies.length} cookie(s)`);
                        let deleted = 0;
                        let pending = cookies.length;
                        for (const cookie of cookies) {
                            GM_cookie.delete({ url: window.location.href, name: cookie.name }, (err) => {
                                if (!err) deleted++;
                                else console.log(`ClearCookies [GM_cookie]: Failed to delete '${cookie.name}':`, err);
                                pending--;
                                if (pending === 0) {
                                    console.log(`ClearCookies [GM_cookie]: Deleted ${deleted}/${cookies.length}`);
                                    resolve(deleted);
                                }
                            });
                        }
                    });
                });
                totalDeleted += gmDeleted;
            } catch (e) {
                console.log("ClearCookies [GM_cookie]: Exception:", e);
            }
        } else {
            console.log("ClearCookies [GM_cookie]: NOT available — enable in Tampermonkey Settings > Config mode: Advanced > Manage cookies: Enabled");
        }

        // Method 2: cookieStore API (Chrome 87+, can delete cookies with paths but NOT HttpOnly)
        if (typeof cookieStore !== "undefined" && cookieStore.getAll) {
            try {
                const allCookies = await cookieStore.getAll();
                console.log(`ClearCookies [cookieStore]: Found ${allCookies.length} cookie(s)`);
                for (const cookie of allCookies) {
                    try {
                        await cookieStore.delete({ name: cookie.name, domain: cookie.domain, path: cookie.path });
                        totalDeleted++;
                    } catch (e) { /* ignore individual failures */ }
                }
                console.log(`ClearCookies [cookieStore]: Processed ${allCookies.length} cookies`);
            } catch (e) {
                console.log("ClearCookies [cookieStore]: Error:", e);
            }
        }

        // Method 3: document.cookie fallback (cannot delete HttpOnly cookies)
        const docCookies = document.cookie.split(";");
        const domains = ["", "alhambra-patronato.es", ".alhambra-patronato.es",
                         "compratickets.alhambra-patronato.es", ".compratickets.alhambra-patronato.es"];
        const paths = ["/", "", "/reservarEntradas.aspx"];
        let docDeleted = 0;
        for (const cookie of docCookies) {
            const name = cookie.split("=")[0].trim();
            if (!name) continue;
            for (const domain of domains) {
                for (const path of paths) {
                    let str = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
                    if (path) str += `; path=${path}`;
                    if (domain) str += `; domain=${domain}`;
                    document.cookie = str;
                }
            }
            docDeleted++;
        }
        console.log(`ClearCookies [document.cookie]: Attempted ${docDeleted} cookie(s)`);
        totalDeleted += docDeleted;

        console.log(`ClearCookies: Total operations: ${totalDeleted}`);
        console.log(`ClearCookies: Remaining document.cookie: "${document.cookie}"`);
    }


    // --- Convert "HH:MM" to minutes since midnight ---
    function timeToMinutes(t) {
        const parts = t.split(":").map(Number);
        return parts[0] * 60 + (parts[1] || 0);
    }

    // --- Pick best slot ---
    function pickBestSlot(rank) {
        if (rank === undefined) rank = findBestSlot ? bestSlotRank : 1;
        const sessions = [...document.querySelectorAll(".hours-select label")];
        const slots = [];
        sessions.forEach(label => {
            const span = label.querySelector("span");
            if (!span) return;
            const match = span.textContent.match(/\((\d+)\)/);
            if (!match) return;
            const tickets = parseInt(match[1], 10);
            const radio = label.querySelector("input[type='radio']");
            if (radio) {
                const timeMatch = span.textContent.match(/(\d{1,2}:\d{2})/);
                const time = timeMatch ? timeMatch[1] : "";
                slots.push({ tickets, radio, text: span.textContent.trim(), time });
            }
        });
        if (slots.length === 0) {
            console.log("AutoFlow: No sessions found");
            return false;
        }
        if (preferredTime && !findBestSlot) {
            console.log(`AutoFlow: Preferred time mode — looking for ${preferredTime}`);
            const totalNeeded = (parseInt(numTickets, 10) || 0) +
                                (parseInt(numTeenTickets, 10) || 0) +
                                (parseInt(numChildTickets, 10) || 0);
            const viable = slots.filter(s => s.tickets >= totalNeeded);
            const pool = viable.length > 0 ? viable : slots;
            if (viable.length === 0) {
                console.log(`AutoFlow: No slots have enough tickets (need ${totalNeeded}), falling back to all slots`);
            }
            const exact = pool.find(s => s.time === preferredTime);
            if (exact) {
                selectedSlot = exact.text;
                sessionStorage.setItem("selectedSlot", selectedSlot);
                console.log(`AutoFlow: Exact preferred time match: ${selectedSlot}`);
                exact.radio.click();
                return true;
            }
            console.log(`AutoFlow: Preferred time ${preferredTime} not found, finding closest`);
            const prefMinutes = timeToMinutes(preferredTime);
            let closest = null;
            let closestDiff = Infinity;
            for (const s of pool) {
                if (!s.time) continue;
                const diff = Math.abs(timeToMinutes(s.time) - prefMinutes);
                if (diff < closestDiff) {
                    closestDiff = diff;
                    closest = s;
                }
            }
            if (closest) {
                selectedSlot = closest.text;
                sessionStorage.setItem("selectedSlot", selectedSlot);
                console.log(`AutoFlow: Closest to ${preferredTime}: ${closest.time} (${closestDiff} min away) — ${selectedSlot}`);
                closest.radio.click();
                return true;
            }
        }
        slots.sort((a, b) => b.tickets - a.tickets);
        const idx = Math.min(rank - 1, slots.length - 1);
        const chosen = slots[idx];
        selectedSlot = chosen.text;
        sessionStorage.setItem("selectedSlot", selectedSlot);
        console.log(`AutoFlow: Picking rank #${idx + 1}/${slots.length} session with ${chosen.tickets} tickets (${selectedSlot})` +
                     (idx + 1 !== rank ? ` [requested rank ${rank}, fell back to ${idx + 1}]` : ""));
        chosen.radio.click();
        return true;
    }

    // --- Fill ticket details on Step 3 form (accepts optional data param) ---
    async function fillTicketDetails(detailsData) {
        const holders = detailsData || firebaseDetails;
        console.log("FillDetails: Filling ticket details for", holders.length, "holder(s)");

        if (!holders || holders.length === 0) {
            console.log("FillDetails: No ticket holders data, skipping fill");
            return;
        }

        console.log("FillDetails: Waiting for ticket details form...");
        try {
            await waitForElement("[id*='_txtNombreEntrada']", 15000);
        } catch (e) {
            console.log("FillDetails: Ticket details form not found:", e);
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));

        const firstHolder = holders[0];

        const fillText = async (id, value, delay = 300) => {
            const el = document.getElementById(id);
            if (!el) { console.log(`FillDetails: Field not found: ${id}`); return; }
            el.focus();
            el.value = value;
            el.dispatchEvent(new Event("input",  { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.blur();
            await new Promise(resolve => setTimeout(resolve, delay));
        };

        const fillSelect = async (id, value, delay = 500) => {
            const el = document.getElementById(id);
            if (!el) { console.log(`FillDetails: Dropdown not found: ${id}`); return; }
            el.value = value;
            el.dispatchEvent(new Event("change", { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, delay));
        };

        for (let i = 0; i < holders.length; i++) {
            const holder = holders[i];
            const pfx = `ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_rptDatosEntradas_ctl0${i}`;

            console.log(`FillDetails: Filling ticket ${i + 1}/${holders.length}: ${holder.firstName} ${holder.lastName}`);

            await fillText(`${pfx}_txtNombreEntrada`,    holder.firstName);
            await fillText(`${pfx}_txtApellidosEntrada`, holder.lastName);
            await fillSelect(`${pfx}_cboTipoDNIEntrada`, "otro_id");
            await fillText(`${pfx}_txtDNIEntrada`,       holder.idNumber);
            await fillSelect(`${pfx}_cboPaisOrigenEntrada`, holder.countryCode, 1500);

            if (holder.countryCode === "724") {
                console.log(`FillDetails: Country is Spain, selecting province...`);
                await fillSelect(`${pfx}_cboProvinciaOrigenEntrada`, "28", 800);
            }

            const isMinor = holder.age >= 3 && holder.age <= 15;
            if (isMinor) {
                console.log(`FillDetails: Ticket ${i + 1} is a minor (age ${holder.age}), filling tutor details`);
                await fillText(`${pfx}_txtNombreEntradaTutor`,    firstHolder.firstName, 1500);
                await fillText(`${pfx}_txtApellidosEntradaTutor`, firstHolder.lastName, 1500);
                await fillSelect(`${pfx}_cboTipoDNIEntradaTutor`, "otro_id", 1500);
                await fillText(`${pfx}_txtDNIEntradaTutor`,       firstHolder.idNumber, 1500);

                const chkName = `ctl00$ContentMaster1$ucReservarEntradasBaseAlhambra1$rptDatosEntradas$ctl0${i}$chkTerminosNinos`;
                const chk = document.querySelector(`input[name="${chkName}"]`);
                if (chk && !chk.checked) {
                    chk.click();
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }

            console.log(`FillDetails: Ticket ${i + 1} filled`);
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        // Auto-check terms
        const chk = document.getElementById("chkAceptaTerminos");
        if (chk && !chk.checked) {
            chk.click();
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log("FillDetails: All ticket details filled!");
    }

    // --- Detect which booking step the page is currently showing ---
    function detectCurrentPage() {
        const h2s = document.querySelectorAll("h2");
        for (const h2 of h2s) {
            if (h2.textContent.includes("403") && h2.textContent.includes("Forbidden")) {
                return "forbidden";
            }
            if (h2.textContent.includes("Checking Your Browser")) {
                return "browser_check";
            }
        }
        if (document.getElementById("ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnFinalizarPaso4") ||
            document.getElementById("ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnFinalizarMenoresPaso4")) {
            return "step4";
        }
        if (document.querySelector("[id*='txtNombreEntrada']")) {
            return "step3";
        }
        if (document.querySelector(".hours-select")) {
            return "hours";
        }
        if (document.getElementById("ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnIrPaso2")) {
            return "tickets";
        }
        if (document.getElementById("ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnIrPaso1") ||
            document.getElementById("ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnIrSubPaso1")) {
            return "step1";
        }
        if (document.getElementById("ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_ucCalendarioPaso1_updCalendario")) {
            return "calendar";
        }
        return "start";
    }

    // --- Send ntfy notification when Step 3 is reached ---
    function sendStep3Notification() {
        console.log("AutoFlow: Trying to send notification.");
        const slot = selectedSlot || sessionStorage.getItem("selectedSlot") || "Unknown";
        const _dv = dateValue || sessionStorage.getItem("dateValue") || "";
        const bookingDay = _dv ? new Date(2000, 0, 1 + Number(_dv)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "Unknown";
        const adults = parseInt(numTickets, 10) || 0;
        const teens = parseInt(numTeenTickets, 10) || 0;
        const children = parseInt(numChildTickets, 10) || 0;
        const total = adults + teens + children;
        let msg = `Step 3 Reached!\n`;
        msg += `Booking Day: ${bookingDay}\n`;
        msg += `Hour: ${slot}\n`;
        msg += `Tickets: ${total} (Adults: ${adults}, Teens: ${teens}, Children: ${children})`;
        GM_xmlhttpRequest({
            method: "POST",
            url: "https://ntfy.sh/alhambraticket",
            data: msg,
            headers: { "Content-Type": "text/plain" },
            onload: () => console.log("AutoFlow: Step 3 ntfy notification sent"),
            onerror: () => console.log("AutoFlow: Step 3 ntfy notification failed")
        });
    }

    // --- Fetch excluded dates from Firebase ---
    async function fetchExcludedDates() {
        if (excludedDates.length > 0) {
            console.log("ExcludedDates: Using cached excluded dates:", excludedDates.join(", "));
            return;
        }
        console.log("ExcludedDates: Fetching from Firebase...");
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/exclude/exclude_tickets?key=${FIREBASE_API_KEY}`,
                onload: (response) => {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data.fields && data.fields.dates && data.fields.dates.stringValue) {
                            excludedDates = data.fields.dates.stringValue.split(",").map(d => d.trim()).filter(d => d);
                            sessionStorage.setItem("excludedDates", JSON.stringify(excludedDates));
                            console.log("ExcludedDates: Loaded excluded dates:", excludedDates.join(", "));
                        } else {
                            console.log("ExcludedDates: No 'dates' field found or empty");
                        }
                    } catch (e) {
                        console.log("ExcludedDates: Parse error:", e);
                    }
                    resolve();
                },
                onerror: () => {
                    console.log("ExcludedDates: Network error");
                    resolve();
                }
            });
        });
    }
    // --- OpenInbox: List inboxes and pick a random existing one ---
    function openinboxListInboxes() {
        return new Promise((resolve, reject) => {
            console.log("OpenInbox: Fetching inboxes...");
            GM_xmlhttpRequest({
                method: "GET",
                url: "https://api.openinbox.io/api/v1/inboxes",
                headers: {
                    "X-API-Key": OPENINBOX_API_KEY
                },
                onload: (response) => {
                    try {
                        const parsed = JSON.parse(response.responseText);
                        const inboxes = Array.isArray(parsed.data) ? parsed.data :
                                        Array.isArray(parsed)      ? parsed      : [];
                        console.log("OpenInbox: Found", inboxes.length, "inbox(es)");
                        resolve(inboxes);
                    } catch (e) {
                        console.log("OpenInbox: Parse error listing inboxes:", e);
                        reject(e);
                    }
                },
                onerror: (err) => {
                    console.log("OpenInbox: Network error listing inboxes:", err);
                    reject(err);
                }
            });
        });
    }

    function openinboxPickRandomInbox() {
        return openinboxListInboxes().then(inboxes => {
            if (inboxes.length === 0) {
                throw new Error("OpenInbox: No inboxes available");
            }
            const picked = inboxes[Math.floor(Math.random() * inboxes.length)];
            const email = picked.email || (picked.attributes && picked.attributes.email);
            const id = picked.id;
            console.log("OpenInbox: Picked random inbox:", email, "(id:", id, ")");
            return { email, id };
        });
    }

    // --- OpenInbox: Poll for latest inbound email ---
    function openinboxPollEmails(inboxId, sentAfter, maxAttempts = 40, intervalMs = 5000) {
        return new Promise((resolve, reject) => {
            let attempts = 0;
            const sentAfterTime = sentAfter ? new Date(sentAfter).getTime() : 0;
            if (sentAfterTime) {
                console.log("OpenInbox: Only accepting emails received after:", new Date(sentAfterTime).toISOString());
            }
            const poll = () => {
                attempts++;
                console.log(`OpenInbox: Polling for email (attempt ${attempts}/${maxAttempts})...`);
                GM_xmlhttpRequest({
                    method: "GET",
                    url: `https://api.openinbox.io/api/v1/inboxes/${inboxId}/emails`,
                    headers: {
                        "X-API-Key": OPENINBOX_API_KEY
                    },
                    onload: (response) => {
                        try {
                            if (attempts <= 3 || attempts % 10 === 0) {
                                console.log("OpenInbox: Raw response status:", response.status);
                                console.log("OpenInbox: Raw response body:", response.responseText.substring(0, 500));
                            }
                            const parsed = JSON.parse(response.responseText);
                            let emails = Array.isArray(parsed.data) ? parsed.data :
                                         Array.isArray(parsed)      ? parsed      : [];
                            // Filter: only emails received after sentAfter
                            if (sentAfterTime && emails.length > 0) {
                                emails = emails.filter(e => {
                                    const recvTime = new Date(e.receivedAt || e.received_at || e.createdAt || e.date || 0).getTime();
                                    return recvTime > sentAfterTime;
                                });
                            }
                            if (emails.length > 0) {
                                // Sort ascending to get the FIRST email after send
                                emails.sort((a, b) => {
                                    const ta = new Date(a.receivedAt || a.received_at || 0).getTime();
                                    const tb = new Date(b.receivedAt || b.received_at || 0).getTime();
                                    return ta - tb;
                                });
                                const latest = emails[0];
                                console.log("OpenInbox: Email received, subject:", latest.subject, "at:", latest.receivedAt || latest.received_at);
                                resolve(latest);
                            } else {
                                if (attempts >= maxAttempts) {
                                    reject(new Error("OpenInbox: Max polling attempts reached"));
                                } else {
                                    setTimeout(poll, intervalMs);
                                }
                            }
                        } catch (e) {
                            console.log("OpenInbox: Parse error:", e);
                            console.log("OpenInbox: Response text:", response.responseText.substring(0, 300));
                            if (attempts >= maxAttempts) {
                                reject(e);
                            } else {
                                setTimeout(poll, intervalMs);
                            }
                        }
                    },
                    onerror: (err) => {
                        console.log("OpenInbox: Poll error:", err);
                        if (attempts >= maxAttempts) {
                            reject(err);
                        } else {
                            setTimeout(poll, intervalMs);
                        }
                    }
                });
            };
            poll();
        });
    }

    // --- OpenInbox: Get full email content by ID ---
    function openinboxGetEmail(emailId) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `https://api.openinbox.io/api/v1/emails/${emailId}`,
                headers: {
                    "X-API-Key": OPENINBOX_API_KEY
                },
                onload: (response) => {
                    try {
                        console.log("OpenInbox: GetEmail response:", response.responseText.substring(0, 500));
                        const parsed = JSON.parse(response.responseText);
                        const data = parsed.data || parsed;
                        resolve(data);
                    } catch (e) {
                        console.log("OpenInbox: Get email parse error:", e);
                        reject(e);
                    }
                },
                onerror: (err) => {
                    console.log("OpenInbox: Get email error:", err);
                    reject(err);
                }
            });
        });
    }

    // --- Email Verification Step (after captcha, before calendar) ---
    async function performEmailVerification() {
        console.log("EmailVerify: Starting email verification step...");

        // Step 1: Pick a random inbox from OpenInbox (existing inboxes only)
        let emailAddr, emailAddressId;
            try {
                const picked = await openinboxPickRandomInbox();
                emailAddr = picked.email;
                emailAddressId = picked.id;
                chosenEmail = emailAddr;
                chosenEmailAddressId = emailAddressId;
                sessionStorage.setItem("chosenEmail", emailAddr);
                sessionStorage.setItem("chosenEmailAddressId", emailAddressId);
                const _dd = document.getElementById("alhDocIdDisplay");
                if (_dd) _dd.textContent = _dd.textContent.replace(/Email:.*/, `Email: ${emailAddr}`);
            } catch (e) {
                console.log("EmailVerify: Failed to pick random inbox from OpenInbox:", e);
                return false;
            }
            
        console.log("EmailVerify: Using email:", emailAddr, "(id:", emailAddressId, ")");

        // Step 2: Wait for the email input field to appear
        console.log("EmailVerify: Waiting for email input field...");
        let emailInput;
        try {
            emailInput = await waitForElement("#ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_txtEmailValidacion", 10000);
        } catch (e) {
            console.log("EmailVerify: Email input field not found:", e);
            return false;
        }

        // Step 3: Fill in the random OpenInbox email address
        emailInput.value = emailAddr;
        emailInput.dispatchEvent(new Event("input", { bubbles: true }));
        emailInput.dispatchEvent(new Event("change", { bubbles: true }));
        console.log("EmailVerify: Email filled:", emailAddr);
        await new Promise(resolve => setTimeout(resolve, 500));

        // Step 4: Click the send button
        const sendBtn = document.getElementById("ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnEnviarMailValidacion");
        if (!sendBtn) {
            console.log("EmailVerify: Send button not found");
            return false;
        }
        const sentAt = new Date().toISOString();
        sendBtn.click();
        console.log("EmailVerify: Send button clicked at", sentAt, ", waiting for email...");
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Check for email send error
        const errorSpan = document.getElementById("ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_lblAvisoValidacionTexto");
        if (errorSpan && errorSpan.textContent.toLowerCase().includes("error")) {
            console.log("EmailVerify: ERROR detected — email send failed:", errorSpan.textContent.trim());
            console.log("EmailVerify: Clearing cookies and restarting via new tab...");
            const transfer = {};
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                transfer[key] = sessionStorage.getItem(key);
            }
            transfer["captchaSolved"] = "false";
            transfer["emailVerified"] = "false";
            delete transfer["cookiesCleared"];
            localStorage.setItem("alhTransfer", JSON.stringify(transfer));
            location.reload();
            // await clearAllCookies();
            // console.log("EmailVerify: Opening new tab and closing this one...");
            // const url = "https://compratickets.alhambra-patronato.es/reservarEntradas.aspx?opc=142&gid=432&lg=en-GB&ca=0&m=GENERAL";
            // const newWin = window.open(url, "_blank");
            // if (newWin) {
            //     window.close();
            //     await new Promise(resolve => setTimeout(resolve, 500));
            //     location.replace("about:blank");
            // } else {
            //     console.log("EmailVerify: Popup blocked, redirecting current tab instead");
            //     location.href = url;
            // }
            return false;
        }

        // Step 5: Poll OpenInbox for the verification email (only emails after send)
        let emailEntry;
        try {
            emailEntry = await openinboxPollEmails(emailAddressId, sentAt);
        } catch (e) {
            console.log("EmailVerify: Failed to get verification email:", e);
            return false;
        }

        // Step 6: Get full email content and extract 6-digit OTP code
        let fullEmail = emailEntry;
        if (emailEntry.id && !emailEntry.textBody && !emailEntry.htmlBody && !emailEntry.body && !emailEntry.text) {
            try {
                fullEmail = await openinboxGetEmail(emailEntry.id);
            } catch (e) {
                console.log("EmailVerify: Failed to fetch full email content:", e);
            }
        }
        const body = fullEmail.textBody || fullEmail.htmlBody || fullEmail.body || fullEmail.text ||
                     fullEmail.text_body || fullEmail.html_body || fullEmail.content || "";
        console.log("EmailVerify: Email body keys:", Object.keys(fullEmail).join(", "));
        console.log("EmailVerify: Email body preview:", body.substring(0, 300));
        const codeMatch = body.match(/(\d{6})/);
        if (!codeMatch) {
            console.log("EmailVerify: Could not extract OTP code from email body");
            console.log("EmailVerify: Full email object:", JSON.stringify(fullEmail).substring(0, 800));
            return false;
        }
        const otpCode = codeMatch[1];
        console.log("EmailVerify: OTP code extracted:", otpCode);

        // Step 7: Wait for the code input field and fill it
        let codeInput;
        try {
            codeInput = await waitForElement("#ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_txtCodigoValidacion", 10000);
        } catch (e) {
            console.log("EmailVerify: Code input field not found:", e);
            return false;
        }
        codeInput.value = otpCode;
        codeInput.dispatchEvent(new Event("input", { bubbles: true }));
        codeInput.dispatchEvent(new Event("change", { bubbles: true }));
        console.log("EmailVerify: OTP code filled");
        await new Promise(resolve => setTimeout(resolve, 500));

        // Step 8: Click the validate code button
        const validateBtn = document.getElementById("ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnValidarCodigo");
        if (!validateBtn) {
            console.log("EmailVerify: Validate code button not found");
            return false;
        }
        validateBtn.click();
        console.log("EmailVerify: Validate code button clicked");
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Step 9: Wait for the "Go to Step 1" button to confirm verification passed
        try {
            await waitForElement("#ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnIrPaso1", 10000);
            console.log("EmailVerify: Verification complete! btnIrPaso1 is now available.");
        } catch (e) {
            console.log("EmailVerify: btnIrPaso1 not found after validation, might have failed:", e);
            return false;
        }

        emailVerified = true;
        sessionStorage.setItem("emailVerified", "true");
        return true;
    }

    // --- Step3 click ---
    function clickStep3() {
        const step3Btn = document.getElementById(
            "ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnIrPaso3"
        );
        if (step3Btn) {
            console.log("AutoFlow: Clicking Step 3");
            step3Btn.click();
        } else {
            console.log("AutoFlow: Step 3 button not found");
        }
    }

    // --- Main auto flow (SEMI-AUTO: stops at Step 3 details page) ---
    async function runAutoFlow() {

        if (running) {
            console.log("AutoFlow: Already running, skipping");
            return;
        }
        running = true;
        keepTabAlive();

        try {

            console.log("AutoFlow: ===== STARTING SEMI-AUTO FLOW =====");
            console.log("AutoFlow: captchaSolved flag:", captchaSolved);
            console.log("AutoFlow: ticketsAdded flag:", ticketsAdded);

            const page = detectCurrentPage();
            console.log("AutoFlow: Detected page:", page);

            // 403 Forbidden — restart
            if (page === "forbidden") {
                console.log("AutoFlow: 403 Forbidden detected, restarting flow in 3s...");
                running = false;
                setTimeout(() => {
                    location.href = "https://compratickets.alhambra-patronato.es/reservarEntradas.aspx?opc=142&gid=432&lg=en-GB&ca=0&m=GENERAL";
                }, 3000);
                return;
            }

            // Browser check page — reload to pass the check
            if (page === "browser_check") {
                console.log("AutoFlow: Browser check detected, reloading in 3s...");
                running = false;
                setTimeout(() => {
                    location.reload();
                }, 3000);
                return;
            }

            // STOP: Step 4 summary page — still handle payment if we got here
            if (page === "step4") {
                console.log("AutoFlow: On Step 4 summary page, clicking Payment button");
                const goToPaymentBtnId = firebaseDetails.some(h => h.age >= 3 && h.age <= 15)
                    ? "#ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnFinalizarMenoresPaso4"
                    : "#ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnFinalizarPaso4";

                // Send ntfy notification
                const _now = new Date().toLocaleString();
                const _bookingId = firebaseDetails.length > 0 ? firebaseDetails[0].lastName : "Unknown";
                const _dv = dateValue || sessionStorage.getItem("dateValue") || "";
                const _bookingDay = _dv ? new Date(2000, 0, 1 + Number(_dv)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "Unknown";
                let _msg = `BookingID: ${_bookingId}\n`;
                _msg += `Date: ${_now}\n`;
                _msg += `Booking Day: ${_bookingDay}\n`;
                _msg += `Hour: ${selectedSlot || sessionStorage.getItem("selectedSlot") || "Unknown"}\n`;
                _msg += `-------------------------\n`;
                _msg += `Tickets found for:\n`;
                for (const h of firebaseDetails) {
                    _msg += `${h.firstName} ${h.lastName}, ID: ${h.idNumber}, Country: ${h.countryCode}\n`;
                }
                _msg += `-------------------------\n`;
                _msg += `Please proceed to payment.`;
                GM_xmlhttpRequest({
                    method: "POST",
                    url: "https://ntfy.sh/alhambraticket",
                    data: _msg,
                    headers: { "Content-Type": "text/plain" },
                    onload: () => console.log("AutoFlow: ntfy notification sent"),
                    onerror: () => console.log("AutoFlow: ntfy notification failed")
                });

                const paymentBtn = await waitForElement(goToPaymentBtnId);
                console.log("AutoFlow: Clicking Payment button");
                paymentBtn.click();
                await new Promise(resolve => setTimeout(resolve, 5000));

                if (firebaseDetails.some(h => h.age >= 3 && h.age <= 15)) {
                    console.log("AutoFlow: Checking for minors warning...");
                    const warningMinorsID = "ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_lnkAlertaMenoresSi";
                    try {
                        const warningLink = await waitForElement(`#${warningMinorsID}`, 5000);
                        if (warningLink) {
                            console.log("AutoFlow: Minors warning found, clicking to confirm...");
                            warningLink.click();
                        }
                    } catch (e) {
                        console.log("AutoFlow: Minors warning not found, proceeding...");
                    }
                }
                console.log("AutoFlow: ===== AUTO FLOW COMPLETE =====");
                running = false;
                return;
            }

            // STOP AT STEP 3: Don't auto-fill, wait for manual "Fill Details"
            if (page === "step3") {
                console.log("AutoFlow: ★ Reached Step 3 — Ticket Details page");
                console.log("AutoFlow: ★ STOPPED. Use 'Fill Details' button to fetch data and fill the form.");
                sendStep3Notification();
                running = false;
                return;
            }

            // RESUME: Hours page → pick best slot, click Step 3, then STOP
            if (page === "hours") {
                console.log("AutoFlow: STEP 4 - Pick Best Time Slot");
                const picked = pickBestSlot();
                if (!picked) {
                    console.log("AutoFlow: ERROR - Could not pick best slot");
                    running = false;
                    return;
                }

                console.log("AutoFlow: Waiting for Step 3 button...");
                const step3BtnResume = await waitForElement(
                    "#ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnIrPaso3"
                );
                console.log("AutoFlow: Clicking Step 3");
                step3BtnResume.click();

                // Wait for Step 3 form to appear
                console.log("AutoFlow: Waiting for Step 3 form to load...");
                try {
                    await waitForElement("[id*='_txtNombreEntrada']", 15000);
                } catch(e) {
                    console.log("AutoFlow: Step 3 form did not load:", e);
                }

                console.log("AutoFlow: ★ Reached Step 3 — Ticket Details page");
                console.log("AutoFlow: ★ STOPPED. Use 'Fill Details' button to fetch data and fill the form.");
                sendStep3Notification();
                running = false;
                return;
            }

            if (page === "step1") {
                // if (!sessionStorage.getItem("cookiesCleared")) {
                //     console.log("AutoFlow: On step1, clearing session via new tab...");
                    
                //     // Save all session data to localStorage so the new tab can restore it
                //     const transfer = {};
                //     for (let i = 0; i < sessionStorage.length; i++) {
                //         const key = sessionStorage.key(i);
                //         transfer[key] = sessionStorage.getItem(key);
                //     }
                //     transfer["cookiesCleared"] = "1";
                //     localStorage.setItem("alhTransfer", JSON.stringify(transfer));
                //     // Clear cookies as much as possible
                //     await clearAllCookies();
                //     console.log("AutoFlow: Opening new tab and closing this one...");
                //     const url = window.location.href;
                //     const newWin = window.open(url, "_blank");
                //     if (newWin) {
                //         window.close();
                //         await new Promise(resolve => setTimeout(resolve, 500));
                //         location.replace("about:blank");
                //     } else {
                //         console.log("AutoFlow: Popup blocked, redirecting current tab instead");
                //         location.href = url;
                //     }
                //     return;
                // }
                ticketsAdded = false;
                captchaSolved = false;
                emailVerified = false;
                sessionStorage.removeItem("emailVerified");
                sessionStopwatchStart = 0;
                sessionStorage.removeItem("sessionStopwatchStart");
                console.log("AutoFlow: Stopwatch reset (step1 reached)");
            }

            // --- From start / calendar / tickets page: run flow until Step 3 ---

            // STEP 0: Solve Captcha
            if (!captchaSolved) {
                console.log("AutoFlow: STEP 0 - Solve Captcha");
                console.log("AutoFlow: Looking for IrPaso1 button...");
                let validateBtn;
                try {
                    validateBtn = await waitForElement(
                        "#ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnIrSubPaso1",
                        15000
                    );
                } catch (e) {
                    console.log("AutoFlow: IrSubPaso1 button not found (timeout). Stopping flow.");
                    running = false;
                    return;
                }
                if (validateBtn) {
                    console.log("AutoFlow: Clicking IrPaso1 to trigger captcha...");
                    validateBtn.click();
                    await new Promise(resolve => setTimeout(resolve, 2000));
                } else {
                    console.log("AutoFlow: IrPaso1 button not found, might already be past captcha");
                }

                if (manualCaptcha) {
                    console.log("AutoFlow: Manual captcha mode - solve captcha then press Confirm Captcha");
                    const confirmBtn = document.getElementById("btnConfirmCaptcha");
                    if (confirmBtn) confirmBtn.style.display = "block";
                    await new Promise(resolve => { manualCaptchaResolver = resolve; });
                    manualCaptchaResolver = null;
                    if (confirmBtn) confirmBtn.style.display = "none";
                    console.log("AutoFlow: Manual captcha confirmed by user");
                    captchaSolved = true;
                    sessionStorage.setItem("captchaSolved", "true");
                } else {
                    if (apiKey2Captcha) {
                        const captchaToken = await solve2Captcha();
                        if (captchaToken) {
                            console.log("AutoFlow: Injecting captcha token...");
                            const script = document.createElement("script");
                            script.textContent = `
                                (function() {
                                    const token = "${captchaToken}";
                                    function patchRecaptcha() {
                                        if (!window.grecaptcha || !window.grecaptcha.getResponse) {
                                            setTimeout(patchRecaptcha, 300);
                                            return;
                                        }
                                        window.__orig_grecaptcha_getResponse =
                                            window.__orig_grecaptcha_getResponse ||
                                            window.grecaptcha.getResponse;
                                        window.grecaptcha.getResponse = function() { return token; };
                                    }
                                    patchRecaptcha();
                                })();
                            `;
                            document.documentElement.appendChild(script);
                            script.remove();
                            console.log("AutoFlow: Captcha token injected successfully");
                            captchaSolved = true;
                            sessionStorage.setItem("captchaSolved", "true");
                        } else {
                            console.log("AutoFlow: Automatic captcha solving failed. Please solve manually.");
                            const solved = await waitForCaptchaSolved();
                            if (solved) {
                                captchaSolved = true;
                                sessionStorage.setItem("captchaSolved", "true");
                            } else {
                                console.log("AutoFlow: Captcha not solved. Stopping.");
                                location.reload();
                                running = false;
                                return;
                            }
                        }
                    } else {
                        console.log("AutoFlow: No API key set. Waiting for manual captcha solve...");
                        const solved = await waitForCaptchaSolved();
                        if (solved) {
                            captchaSolved = true;
                            sessionStorage.setItem("captchaSolved", "true");
                        } else {
                            console.log("AutoFlow: Captcha not solved. Stopping.");
                            running = false;
                            return;
                        }
                    }
                }

                console.log("AutoFlow: Captcha complete!");
                console.log("AutoFlow: Clicking Validate again to proceed to email verification...");
                const irPaso1BtnAfter = document.getElementById(
                    "ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnIrSubPaso1"
                );
                if (irPaso1BtnAfter) {
                    irPaso1BtnAfter.click();
                    console.log("AutoFlow: Validation clicked successfully");
                } else {
                    console.log("AutoFlow: Validation button not found after captcha");
                }
                await new Promise(resolve => setTimeout(resolve, 3000));

                // EMAIL VERIFICATION STEP
                if (!emailVerified) {
                    if (manualEmail) {
                        // Manual email verification: user does it themselves
                        console.log("AutoFlow: Manual email verification mode - complete email verification then press Confirm Email");
                        const confirmEmailBtn = document.getElementById("btnConfirmEmail");
                        if (confirmEmailBtn) confirmEmailBtn.style.display = "block";
                        await new Promise(resolve => { manualEmailResolver = resolve; });
                        manualEmailResolver = null;
                        if (confirmEmailBtn) confirmEmailBtn.style.display = "none";
                        console.log("AutoFlow: Manual email verification confirmed by user");
                        emailVerified = true;
                        sessionStorage.setItem("emailVerified", "true");
                    } else {
                        // Auto email verification via Tigrmail
                        console.log("AutoFlow: Starting automatic email verification...");
                        const verified = await performEmailVerification();
                        if (!verified) {
                            console.log("AutoFlow: Email verification failed. Stopping.");
                            running = false;
                            return;
                        }
                        console.log("AutoFlow: Email verification passed!");
                    }
                    // Click btnIrPaso1 to go to the calendar page
                    const irPaso1Btn = document.getElementById("ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnIrPaso1");
                    if (irPaso1Btn) {
                        console.log("AutoFlow: Clicking btnIrPaso1 to proceed to calendar...");
                        irPaso1Btn.click();
                        await new Promise(resolve => setTimeout(resolve, 3000));
                    } else {
                        console.log("AutoFlow: btnIrPaso1 not found after email verification");
                    }
                } else {
                    console.log("AutoFlow: Email already verified, skipping");
                }
            } else {
                console.log("AutoFlow: Captcha already solved, skipping");
            }

            // STEP 1: Choose date
            if (!ticketsAdded) {
                console.log("AutoFlow: STEP 1 - Choose Date");
                console.log("AutoFlow: Waiting for calendar...");
                try {
                    await waitForElement(
                        "#ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_ucCalendarioPaso1_updCalendario",
                        10000
                    );
                } catch (e) {
                    console.log("AutoFlow: Calendar not found, reloading page...");
                    location.reload();
                    return;
                }
                console.log("AutoFlow: Calendar found!");

                // Reset cookiesCleared so next step1 visit will clear cookies again
                sessionStorage.removeItem("cookiesCleared");

                sessionStopwatchStart = Date.now();
                sessionStorage.setItem("sessionStopwatchStart", String(sessionStopwatchStart));
                console.log("AutoFlow: Stopwatch started (27 min)");

                if (dateValue) {
                    console.log("AutoFlow: Choosing date:", dateValue);
                    __doPostBack(
                        'ctl00$ContentMaster1$ucReservarEntradasBaseAlhambra1$ucCalendarioPaso1$calendarioFecha',
                        dateValue
                    );
                    console.log("AutoFlow: Waiting 5 seconds for page to reload after date selection...");
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    console.log("AutoFlow: Date selection complete");
                } else {
                    console.log("AutoFlow: ERROR - No date value set!");
                    running = false;
                    return;
                }

                // STEP 2: Add tickets
                console.log("AutoFlow: STEP 2 - Add Tickets");
                for (const type of TICKET_TYPES) {
                    const count = type.getCount();
                    if (count > 0) {
                        console.log(`AutoFlow: Adding ${count} ${type.label} ticket(s)...`);
                        const success = await addTickets(count, type.btnId);
                        if (!success) {
                            console.log(`AutoFlow: Failed to add ${type.label} tickets`);
                            running = false;
                            return;
                        }
                    }
                }
                console.log("AutoFlow: All ticket types added successfully");
                ticketsAdded = true;
                sessionStorage.setItem("ticketsAdded", "true");
                console.log("AutoFlow: Tickets flag set to true");

                console.log("AutoFlow: Waiting 3 seconds for page to stabilize...");
                await new Promise(resolve => setTimeout(resolve, 3000));
            } else {
                console.log("AutoFlow: Date/Tickets already done, skipping to Step 2");
            }

            // STEP 3: Click Step 2 until hours page loads
            console.log("AutoFlow: STEP 3 - Go to Hours Selection (Step 2 loop)");

            while (true) {
                const step2Btn = document.getElementById(
                    "ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnIrPaso2"
                );

                if (step2Btn) {
                    const availableCells = document.querySelectorAll('td[data-estado="naranja"], td[data-estado="verde"]');
                    if (availableCells.length > 0) {
                        let ntfyMsg = "Alhambra Calendar Availability:\n";
                        let hasNonExcluded = false;
                        for (const cell of availableCells) {
                            const dayNum = (cell.querySelector("a") || cell).textContent.trim();
                            if (excludedDates.includes(dayNum)) {
                                console.log(`AutoFlow: Skipping excluded date: Day ${dayNum}`);
                                continue;
                            }
                            const color = cell.getAttribute("data-estado");
                            ntfyMsg += `Day ${dayNum} - ${color}\n`;
                            console.log(`AutoFlow: Available date found: Day ${dayNum} (${color})`);
                            hasNonExcluded = true;
                        }
                        if (!hasNonExcluded) {
                            console.log("AutoFlow: All available dates are excluded, skipping notification");
                        } else {
                            GM_xmlhttpRequest({
                                method: "POST",
                                url: "https://ntfy.sh/alternative_date_found",
                                data: ntfyMsg,
                                headers: { "Content-Type": "text/plain" },
                                onload: () => console.log("AutoFlow: Calendar availability ntfy sent"),
                                onerror: () => console.log("AutoFlow: Calendar availability ntfy failed")
                            });
                        }
                    }
                    // Check countdown timer
                    let shouldRedirect = false;
                    const demoSpan = document.getElementById("demo");
                    if (demoSpan) {
                        const timeText = demoSpan.textContent.trim();
                        const parts = timeText.split(":");
                        if (parts.length === 2) {
                            const totalSeconds = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
                            if (totalSeconds < 180) {
                                console.log(`AutoFlow: Countdown ${timeText} is below 3 minutes`);
                                shouldRedirect = true;
                            }
                        }
                    }
                    if (!shouldRedirect && sessionStopwatchStart > 0) {
                        const elapsed = Date.now() - sessionStopwatchStart;
                        if (elapsed >= SESSION_TIMEOUT_MS) {
                            console.log(`AutoFlow: Stopwatch expired (${Math.round(elapsed / 1000)}s elapsed)`);
                            shouldRedirect = true;
                        }
                    }
                    if (shouldRedirect) {
                        console.log("AutoFlow: Session timeout reached, redirecting...");
                        sessionStopwatchStart = 0;
                        sessionStorage.removeItem("sessionStopwatchStart");
                        // Mark cookies as already cleared so step1 won't do new-tab dance again
                        sessionStorage.setItem("cookiesCleared", "1");
                        location.href = "https://compratickets.alhambra-patronato.es/reservarEntradas.aspx?opc=142&gid=432&lg=en-GB&ca=0&m=GENERAL";
                        return;
                    }

                    console.log("AutoFlow: Clicking Step 2");
                    step2Btn.click();
                    console.log("AutoFlow: Waiting 5 seconds for page to reload...");
                    await new Promise(resolve => setTimeout(resolve, 5000));

                    const hoursSelect = document.querySelector(".hours-select");
                    if (hoursSelect) {
                        console.log("AutoFlow: Hours selection page reached!");
                        break;
                    }
                    console.log("AutoFlow: Hours not found yet, will retry Step 2");
                } else {
                    const hoursSelect = document.querySelector(".hours-select");
                    if (hoursSelect) {
                        console.log("AutoFlow: Already on hours selection page");
                        break;
                    }
                    console.log("AutoFlow: Step 2 button not found, waiting...");
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            // STEP 4: Pick best slot
            console.log("AutoFlow: STEP 4 - Pick Best Time Slot");
            const picked = pickBestSlot();
            if (!picked) {
                console.log("AutoFlow: ERROR - Could not pick best slot");
                running = false;
                return;
            }

            // STEP 5: Go to Step 3 — then STOP
            console.log("AutoFlow: STEP 5 - Go to Step 3");
            console.log("AutoFlow: Waiting for Step 3 button...");
            const step3Btn = await waitForElement(
                "#ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnIrPaso3"
            );
            console.log("AutoFlow: Clicking Step 3");
            step3Btn.click();

            // Wait for Step 3 form to appear
            console.log("AutoFlow: Waiting for Step 3 form to load...");
            try {
                await waitForElement("[id*='_txtNombreEntrada']", 15000);
            } catch(e) {
                console.log("AutoFlow: Step 3 form did not load:", e);
            }

            console.log("AutoFlow: ★ Reached Step 3 — Ticket Details page");
            console.log("AutoFlow: ★ STOPPED. Use 'Fill Details' button to fetch data and fill the form.");
            sendStep3Notification();

        } catch (err) {
            console.log("AutoFlow ERROR:", err);
            if (autoFlow) {
                console.log("AutoFlow: Error during flow, reloading page in 3s...");
                running = false;
                await new Promise(resolve => setTimeout(resolve, 3000));
                location.reload();
                return;
            }
        }

        running = false;
    }

    // --- Panel UI ---
    function createPanel() {

        if (document.getElementById("alhambraHelper")) return;

        const panel = document.createElement("div");
        panel.id = "alhambraHelper";

        Object.assign(panel.style, {
            position: "fixed",
            top: "0",
            left: "0",
            right: "0",
            zIndex: "999999",
            background: "#1f2933",
            color: "white",
            fontFamily: "Arial, sans-serif",
            fontSize: "13px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.6)",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            padding: "8px 14px"
        });

        const btnStyle = "padding:8px 14px;cursor:pointer;border:none;border-radius:3px;font-size:19px;background:#2d3e50;color:white;";
        const inputStyle = "padding:6px 4px;font-size:19px;border-radius:3px;border:1px solid #555;background:#111;color:white;text-align:center;";
        const labelStyle = "font-size:11px;color:#aaa;margin-right:2px;";
        const rowStyle = "display:flex;align-items:center;gap:6px;";

        panel.innerHTML = `
            <div style="${rowStyle}">
                <span style="font-weight:bold;color:#c084fc;font-size:14px;margin-right:4px">&#9670; ALH Semi</span>

                <span style="color:#444;margin:0 4px">|</span>

                <span style="${labelStyle}">Date</span>
                <input id="inputDate" type="text" placeholder="Date value" style="${inputStyle}width:90px;" value="${dateValue}" />
                <button id="btnChooseDate" style="${btnStyle}">Choose Date</button>

                <span style="color:#444;margin:0 4px">|</span>

                <span style="${labelStyle}">Adults</span>
                <input id="inputTickets" type="number" min="1" style="${inputStyle}width:32px;" value="${numTickets}" />
                <button id="btnAddTickets" style="${btnStyle}">Add</button>

                <span style="${labelStyle}">Teens</span>
                <input id="inputTeenTickets" type="number" min="0" style="${inputStyle}width:32px;" value="${numTeenTickets}" />
                <button id="btnAddTeenTickets" style="${btnStyle}">Add</button>

                <span style="${labelStyle}">Child</span>
                <input id="inputChildTickets" type="number" min="0" style="${inputStyle}width:32px;" value="${numChildTickets}" />
                <button id="btnAddChildTickets" style="${btnStyle}">Add</button>
            </div>

            <div style="${rowStyle}">
                <button id="btnCaptchaMode" style="${btnStyle}">CAPTCHA: ${manualCaptcha ? 'MANUAL' : 'AUTO'}</button>
                <button id="btnConfirmCaptcha" style="display:none;${btnStyle}background:#27ae60;font-weight:bold;">&#x2714; Confirm Captcha</button>
                <button id="btnEmailMode" style="${btnStyle}">EMAIL: ${manualEmail ? 'MANUAL' : 'AUTO'}</button>
                <button id="btnConfirmEmail" style="display:none;${btnStyle}background:#2980b9;font-weight:bold;">&#x2714; Confirm Email</button>
                <button id="btnAutoFlow" style="${btnStyle}${autoFlow ? 'background:#1e8449;' : 'background:#c0392b;'}">AUTO: ${autoFlow ? 'ON' : 'OFF'}</button>

                <span style="color:#444;margin:0 4px">|</span>

                <button id="btnReset" style="${btnStyle}background:#c0392b;">RESET</button>
            </div>

            <!-- FILL DETAILS ROW (Semi-Auto) -->
            <div style="${rowStyle}background:#1a1a2e;padding:6px 8px;border-radius:4px;border:1px solid #8e44ad;">
                <span style="font-weight:bold;color:#c084fc;font-size:12px;margin-right:4px">FILL:</span>
                <span style="${labelStyle}">Doc ID</span>
                <input id="inputFillDocId" type="text" placeholder="Firebase Doc ID" style="${inputStyle}width:160px;" value="${firebaseDocId}" />
                <span style="color:#f0c040;font-size:13px;font-weight:bold;margin-left:4px;" id="alhDateDisplay">${dateValue ? new Date(2000, 0, 1 + Number(dateValue)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "No date"}</span>
                <button id="btnFillDetails" style="${btnStyle}background:#8e44ad;font-weight:bold;">&#x270D; Fill Details</button>
                <button id="btnGoStep4" style="${btnStyle}background:#27ae60;font-weight:bold;">&#x2192; Go to Step 4</button>
            </div>

            <div id="alhDocIdDisplay" style="padding: 4px 8px; background: #0d1117; color: #aaa; font-size: 14px; font-family: monospace; border-top: 1px solid #2d3e50;"></div>
            <div id="alhLog" style="width:100%;box-sizing:border-box;height:116px;overflow-y:auto;background:#0d1117;border-top:1px solid #2d3e50;font-size:11px;font-family:monospace;color:#8edb8e;padding:4px 8px;line-height:1.5;white-space:pre-wrap;word-break:break-all;"></div>
        `;

        document.body.style.marginTop = "230px";

        document.body.appendChild(panel);

        // Update Doc ID display
        const docIdDisplay = document.getElementById("alhDocIdDisplay");
        if (docIdDisplay) {
            docIdDisplay.textContent = `Doc ID: ${firebaseDocId || "Not set"}  |  Slot: ${findBestSlot ? `Rank #${bestSlotRank}` : (preferredTime ? `Preferred ${preferredTime}` : "default")}  |  Email: ${chosenEmail || "not picked yet"}`;
        }

        // Inject button UX styles
        const alhStyle = document.createElement("style");
        alhStyle.textContent = `
            #alhambraHelper button {
                transition: filter 0.1s, transform 0.1s, opacity 0.15s;
                user-select: none;
            }
            #alhambraHelper button:hover:not(:disabled) { filter: brightness(1.25); }
            #alhambraHelper button:active:not(:disabled) { transform: scale(0.94); filter: brightness(0.9); }
            #alhambraHelper button:disabled { opacity: 0.45; cursor: not-allowed !important; }
            @keyframes alhPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(30,132,73,0.7); } 50% { box-shadow: 0 0 0 5px rgba(30,132,73,0); } }
            #btnAutoFlow.alh-running { animation: alhPulse 1.4s infinite; }
        `;
        document.head.appendChild(alhStyle);

        // --- UX helpers ---
        const _btnOrigText = {};
        function btnBusy(id, busyText) {
            const b = document.getElementById(id);
            if (!b) return;
            _btnOrigText[id] = _btnOrigText[id] || b.innerText;
            b.disabled = true;
            b.innerText = busyText || "…";
        }
        function btnReady(id, overrideText) {
            const b = document.getElementById(id);
            if (!b) return;
            b.disabled = false;
            b.innerText = overrideText || _btnOrigText[id] || b.innerText;
        }
        function btnFlash(id) {
            const b = document.getElementById(id);
            if (!b) return;
            b.disabled = true;
            setTimeout(() => { b.disabled = false; }, 1200);
        }

        // Save date input value on change
        document.getElementById("inputDate").oninput = (e) => {
            dateValue = e.target.value;
            sessionStorage.setItem("dateValue", dateValue);
        };

        document.getElementById("inputTickets").oninput = (e) => {
            numTickets = e.target.value;
            sessionStorage.setItem("numTickets", numTickets);
        };

        document.getElementById("btnChooseDate").onclick = () => {
            const value = document.getElementById("inputDate").value;
            if (value) {
                btnBusy("btnChooseDate", "⏳…");
                __doPostBack(
                    'ctl00$ContentMaster1$ucReservarEntradasBaseAlhambra1$ucCalendarioPaso1$calendarioFecha',
                    value
                );
                console.log("Choose Date: Called __doPostBack with value:", value);
                setTimeout(() => btnReady("btnChooseDate"), 6000);
            } else {
                console.log("Choose Date: No value entered");
            }
        };

        document.getElementById("inputTeenTickets").oninput = (e) => {
            numTeenTickets = e.target.value;
            sessionStorage.setItem("numTeenTickets", numTeenTickets);
        };

        document.getElementById("inputChildTickets").oninput = (e) => {
            numChildTickets = e.target.value;
            sessionStorage.setItem("numChildTickets", numChildTickets);
        };

        document.getElementById("btnAddTickets").onclick = async () => {
            const count = parseInt(document.getElementById("inputTickets").value, 10);
            if (count > 0) {
                btnBusy("btnAddTickets", "⏳…");
                await addTickets(count, TICKET_TYPES[0].btnId);
                btnReady("btnAddTickets", "✔ Add");
                setTimeout(() => btnReady("btnAddTickets"), 2000);
            }
        };

        document.getElementById("btnAddTeenTickets").onclick = async () => {
            const count = parseInt(document.getElementById("inputTeenTickets").value, 10);
            if (count > 0) {
                btnBusy("btnAddTeenTickets", "⏳…");
                await addTickets(count, TICKET_TYPES[1].btnId);
                btnReady("btnAddTeenTickets", "✔ Add");
                setTimeout(() => btnReady("btnAddTeenTickets"), 2000);
            }
        };

        document.getElementById("btnAddChildTickets").onclick = async () => {
            const count = parseInt(document.getElementById("inputChildTickets").value, 10);
            if (count > 0) {
                btnBusy("btnAddChildTickets", "⏳…");
                await addTickets(count, TICKET_TYPES[2].btnId);
                btnReady("btnAddChildTickets", "✔ Add");
                setTimeout(() => btnReady("btnAddChildTickets"), 2000);
            }
        };

        document.getElementById("btnCaptchaMode").onclick = () => {
            manualCaptcha = !manualCaptcha;
            sessionStorage.setItem("manualCaptcha", manualCaptcha);
            document.getElementById("btnCaptchaMode").innerText =
                `CAPTCHA: ${manualCaptcha ? 'MANUAL' : 'AUTO'}`;
            console.log("Captcha mode:", manualCaptcha ? "MANUAL" : "AUTO");
        };

        document.getElementById("btnEmailMode").onclick = () => {
            manualEmail = !manualEmail;
            sessionStorage.setItem("manualEmail", manualEmail);
            document.getElementById("btnEmailMode").innerText =
                `EMAIL: ${manualEmail ? 'MANUAL' : 'AUTO'}`;
            console.log("Email mode:", manualEmail ? "MANUAL" : "AUTO");
        };

        document.getElementById("btnConfirmCaptcha").onclick = () => {
            if (manualCaptchaResolver) {
                manualCaptchaResolver();
            }
        };

        document.getElementById("btnConfirmEmail").onclick = () => {
            if (manualEmailResolver) {
                manualEmailResolver();
            }
        };

        document.getElementById("btnAutoFlow").onclick = () => {
            autoFlow = !autoFlow;
            sessionStorage.setItem("autoFlow", autoFlow);

            if (autoFlow) {
                captchaSolved = false;
                sessionStorage.setItem("captchaSolved", "false");
                ticketsAdded = false;
                sessionStorage.setItem("ticketsAdded", "false");
                sessionStorage.removeItem("flowStep");
                sessionStorage.removeItem("cookiesCleared");
            }

            const btn = document.getElementById("btnAutoFlow");
            btn.innerText = `AUTO: ${autoFlow ? 'ON' : 'OFF'}`;
            btn.style.background = autoFlow ? "#1e8449" : "#c0392b";
            btn.classList.toggle("alh-running", autoFlow);

            if (autoFlow) runAutoFlow();
        };

        if (autoFlow) document.getElementById("btnAutoFlow").classList.add("alh-running");

        // --- FILL DETAILS BUTTON (Semi-Auto feature) ---
        document.getElementById("btnFillDetails").onclick = async () => {
            const docId = document.getElementById("inputFillDocId").value.trim();
            if (!docId) {
                console.log("FillDetails: No Doc ID entered!");
                return;
            }

            btnBusy("btnFillDetails", "⏳ Fetching…");
            console.log(`FillDetails: Fetching data for doc '${docId}' (non-persistent)...`);

            // Fetch from Firebase — this data is NOT saved to sessionStorage
            const data = await fetchFirebaseData(docId);

            if (data.error || data.ticketHolders.length === 0) {
                console.log("FillDetails: No ticket holders found or fetch error");
                btnReady("btnFillDetails", "✘ Error");
                setTimeout(() => btnReady("btnFillDetails"), 3000);
                return;
            }

            console.log(`FillDetails: Got ${data.ticketHolders.length} holder(s), filling form...`);
            btnBusy("btnFillDetails", "⏳ Filling…");

            // Fill the form using the freshly-fetched data (not persisted)
            await fillTicketDetails(data.ticketHolders);

            // Store for Step 4 payment notification (persisted so it survives page reload)
            firebaseDetails = data.ticketHolders;
            sessionStorage.setItem("ticketHolders", JSON.stringify(firebaseDetails));

            btnReady("btnFillDetails", "✔ Filled!");
            console.log("FillDetails: Done! You can now click 'Go to Step 4'.");
            setTimeout(() => btnReady("btnFillDetails"), 4000);
        };

        // --- GO TO STEP 4 BUTTON ---
        document.getElementById("btnGoStep4").onclick = async () => {
            const step4Btn = document.getElementById(
                "ctl00_ContentMaster1_ucReservarEntradasBaseAlhambra1_btnIrPaso4"
            );
            if (step4Btn) {
                btnBusy("btnGoStep4", "⏳…");
                console.log("GoStep4: Clicking Step 4 button");
                step4Btn.click();
            } else {
                console.log("GoStep4: Step 4 button not found on this page");
            }
        };

        document.getElementById("btnReset").onclick = () => {
            console.log("RESET: Clearing all flags and stopping");
            running = false;
            if (manualCaptchaResolver) {
                manualCaptchaResolver = null;
            }
            const confirmBtn = document.getElementById("btnConfirmCaptcha");
            if (confirmBtn) confirmBtn.style.display = "none";

            captchaSolved = false;
            sessionStorage.setItem("captchaSolved", "false");
            ticketsAdded = false;
            sessionStorage.setItem("ticketsAdded", "false");
            emailVerified = false;
            sessionStorage.removeItem("emailVerified");
            sessionStorage.removeItem("flowStep");
            sessionStorage.removeItem("cookiesCleared");

            autoFlow = false;
            sessionStorage.setItem("autoFlow", "false");

            firebaseDocId = "";
            sessionStorage.removeItem("firebaseDocId");

            selectedSlot = "";
            sessionStorage.removeItem("selectedSlot");

            firebaseFetched = false;
            sessionStorage.removeItem("firebaseFetched");

            firebaseDetails = [];
            sessionStorage.removeItem("ticketHolders");

            sessionStopwatchStart = 0;
            sessionStorage.removeItem("sessionStopwatchStart");

            dateValue = "";
            sessionStorage.removeItem("dateValue");
            numTickets = "1";
            sessionStorage.removeItem("numTickets");
            numTeenTickets = "0";
            sessionStorage.removeItem("numTeenTickets");
            numChildTickets = "0";
            sessionStorage.removeItem("numChildTickets");

            findBestSlot = true;
            bestSlotRank = 1;
            preferredTime = "";
            sessionStorage.removeItem("findBestSlot");
            sessionStorage.removeItem("bestSlotRank");
            sessionStorage.removeItem("preferredTime");
            excludedDates = [];
            sessionStorage.removeItem("excludedDates");
            manualEmail = false;
            sessionStorage.removeItem("manualEmail");
            chosenEmail = "";
            chosenEmailAddressId = "";
            sessionStorage.removeItem("chosenEmail");
            sessionStorage.removeItem("chosenEmailAddressId");
            document.getElementById("btnAutoFlow").innerText = 'AUTO: OFF';

            console.log("RESET: Complete - All flags cleared");

            location.href = "https://compratickets.alhambra-patronato.es/reservarEntradas.aspx?opc=142&gid=432&lg=en-GB&ca=0&m=GENERAL";
        };
    }

    // --- Initialize ---
    // Restore session data from localStorage if transferred from a previous tab
    const _alhTransferRaw = localStorage.getItem("alhTransfer");
    if (_alhTransferRaw) {
        try {
            const _transfer = JSON.parse(_alhTransferRaw);
            for (const [key, value] of Object.entries(_transfer)) {
                sessionStorage.setItem(key, value);
            }
            console.log("Init: Restored session data from previous tab (", Object.keys(_transfer).length, "keys)");
            // Re-read variables that were loaded before transfer
            autoFlow = sessionStorage.getItem("autoFlow") === "true";
            dateValue = sessionStorage.getItem("dateValue") || "";
            numTickets = sessionStorage.getItem("numTickets") || "1";
            captchaSolved = sessionStorage.getItem("captchaSolved") === "true";
            ticketsAdded = sessionStorage.getItem("ticketsAdded") === "true";
            manualCaptcha = sessionStorage.getItem("manualCaptcha") === "true";
            manualEmail = sessionStorage.getItem("manualEmail") === "true";
            numTeenTickets = sessionStorage.getItem("numTeenTickets") || "0";
            numChildTickets = sessionStorage.getItem("numChildTickets") || "0";
            selectedSlot = sessionStorage.getItem("selectedSlot") || "";
            firebaseFetched = sessionStorage.getItem("firebaseFetched") === "true";
            firebaseDocId = sessionStorage.getItem("firebaseDocId") || "";
            emailVerified = sessionStorage.getItem("emailVerified") === "true";
            findBestSlot = sessionStorage.getItem("findBestSlot") !== "false";
            bestSlotRank = parseInt(sessionStorage.getItem("bestSlotRank"), 10) || 1;
            preferredTime = sessionStorage.getItem("preferredTime") || "";
            chosenEmail = sessionStorage.getItem("chosenEmail") || "";
            chosenEmailAddressId = sessionStorage.getItem("chosenEmailAddressId") || "";
            try {
                const stored = sessionStorage.getItem("ticketHolders");
                if (stored) firebaseDetails = JSON.parse(stored);
            } catch(e) {}
            try {
                const storedExcl = sessionStorage.getItem("excludedDates");
                if (storedExcl) excludedDates = JSON.parse(storedExcl);
            } catch(e) {}
        } catch (e) {
            console.log("Init: Error restoring transfer data:", e);
        }
        localStorage.removeItem("alhTransfer");
    }

    const wait = setInterval(async () => {

        if (document.body) {

            clearInterval(wait);

            // Early check: if stuck on "Checking Your Browser" page, reload immediately
            const _h2s = document.querySelectorAll("h2");
            for (const _h2 of _h2s) {
                if (_h2.textContent.includes("Checking Your Browser")) {
                    console.log("Init: Browser check page detected, reloading in 3s...");
                    setTimeout(() => location.reload(), 3000);
                    return;
                }
            }

            if (!firebaseDocId) {
                firebaseDocId = await askForDocId();
                sessionStorage.setItem("firebaseDocId", firebaseDocId);
            }

            let firebaseError = false;

            if (firebaseFetched) {
                console.log("Firebase: Using cached data from sessionStorage (skipping fetch)");
            } else {
                const firebaseData = await fetchFirebaseData(firebaseDocId);

                if (firebaseData.day) {
                    dateValue = firebaseData.day;
                    sessionStorage.setItem("dateValue", dateValue);
                    console.log("Firebase: dateValue set to:", dateValue);
                } else {
                    console.log("Firebase: Could not load day, using existing value:", dateValue);
                }

                if (firebaseData.ticketHolders.length > 0) {
                    firebaseDetails = firebaseData.ticketHolders;
                    sessionStorage.setItem("ticketHolders", JSON.stringify(firebaseDetails));

                    const adults   = firebaseDetails.filter(h => h.age > 15).length;
                    const teens    = firebaseDetails.filter(h => h.age >= 12 && h.age <= 15).length;
                    const children = firebaseDetails.filter(h => h.age >= 3  && h.age <= 11).length;

                    numTickets      = String(adults);
                    numTeenTickets  = String(teens);
                    numChildTickets = String(children);

                    sessionStorage.setItem("numTickets",      numTickets);
                    sessionStorage.setItem("numTeenTickets",  numTeenTickets);
                    sessionStorage.setItem("numChildTickets", numChildTickets);

                    console.log(`Firebase: Tickets — Adults: ${adults}, Teens: ${teens}, Children: ${children}`);
                }

                findBestSlot = firebaseData.findBestSlot;
                bestSlotRank = firebaseData.bestSlotRank;
                preferredTime = firebaseData.preferredTime || "";
                sessionStorage.setItem("findBestSlot", String(findBestSlot));
                sessionStorage.setItem("bestSlotRank", String(bestSlotRank));
                sessionStorage.setItem("preferredTime", preferredTime);
                console.log(`Firebase: Slot picking — findBestSlot: ${findBestSlot}, bestSlotRank: ${bestSlotRank}, preferredTime: ${preferredTime || "not set"}`);

                if (!firebaseData.error) {
                    firebaseFetched = true;
                    sessionStorage.setItem("firebaseFetched", "true");
                } else {
                    firebaseError = true;
                }
            }
            await fetchExcludedDates();
            dismissCookieBanner();
            createPanel();
            // Flush buffered log messages
            const _logDiv = document.getElementById("alhLog");
            if (_logDiv && _alhLogBuffer.length > 0) {
                _alhLogBuffer.forEach(msg => {
                    const line = document.createElement("div");
                    line.textContent = msg;
                    _logDiv.appendChild(line);
                });
                _logDiv.scrollTop = _logDiv.scrollHeight;
            }

            if (firebaseError) {
                const _logDiv2 = document.getElementById("alhLog");
                if (_logDiv2) {
                    const warn = document.createElement("div");
                    warn.textContent = "⚠ ERROR: Could not fetch document from Firebase! Check doc ID and connection.";
                    warn.style.cssText = "color:#ff4444;font-weight:bold;background:#2a0000;padding:3px 6px;border-left:3px solid #ff4444;margin:2px 0;";
                    _logDiv2.appendChild(warn);
                    _logDiv2.scrollTop = _logDiv2.scrollHeight;
                }
            }

            if (autoFlow) {
                console.log("AutoFlow: Page loaded with autoFlow=true, ticketsAdded=", ticketsAdded);
                runAutoFlow();
            }

        }

    }, 500);

})();
