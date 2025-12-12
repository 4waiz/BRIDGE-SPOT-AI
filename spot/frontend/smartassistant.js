const protocol = window.location.protocol === "https:" ? "wss" : "ws";
const host = window.location.hostname == "" ? "localhost" : window.location.hostname;
const wsUrl = `${protocol}://${host}:8001/ws/`;
const sessionId = Math.floor(Math.random() * 90000 + 10000);

function startwwd() {    
    const requestIdLanguage = Math.floor(Math.random() * 90000 + 10000);
    const requestIdWWD = Math.floor(Math.random() * 90000 + 10000);

    const websocketMessageLanguage = {
        session_id: sessionId,
        request_id: requestIdLanguage,
        language: "en",
    };

    const websocketMessageWWD = {
        session_id: sessionId,
        server_wwd: true,
        request_id: requestIdWWD,
    };

    const ws = new WebSocket(wsUrl);

    ws.onopen = function() {
        console.log("WebSocket connection opened.");
        ws.send(JSON.stringify(websocketMessageLanguage));
        console.log("Sent message:", websocketMessageLanguage);
        ws.send(JSON.stringify(websocketMessageWWD));
        console.log("Sent message:", websocketMessageWWD);
        setTimeout(() => {
            alert("Use 'Hey Spot' to ask questions.")
          }, 3000);
    };

    ws.onmessage = function(event) {
        console.log("Received message:", event.data);
    };

    ws.onerror = function(error) {
        console.error("WebSocket error:", error);
        alert("Error with smart assistant.")
    };

    ws.onclose = function() {
        console.log("WebSocket connection closed.");
    };
}
