import L from "leaflet";
import "leaflet-routing-machine";

// --- DOM Elements ---
const mapDiv = 'map';
const startButton = document.getElementById('start-button');
const instructionsDiv = document.getElementById('instructions');
const gameInfoDiv = document.getElementById('game-info');
const startCityEl = document.getElementById('start-city');
const endCityEl = document.getElementById('end-city');
const currentInstructionEl = document.getElementById('current-instruction');
const userCommandEl = document.getElementById('user-command');
const botStatusEl = document.getElementById('bot-status');
const loadingOverlay = document.getElementById('loading-overlay');

// --- Map & Game State ---
let map;
let routingControl;
let botMarker;
let traveledPath;
let routeInstructions = [];
let routeCoordinates = [];
let currentStep = 0;
let isBotMoving = false;
let gameInProgress = false;

const botIcon = L.icon({
    iconUrl: 'bot.png',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
});

// --- Speech Recognition ---
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition;
if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
        if (!gameInProgress || isBotMoving) return;
        const last = event.results.length - 1;
        const command = event.results[last][0].transcript.trim().toLowerCase();
        userCommandEl.textContent = `"${command}"`;
        checkCommand(command);
    };

    recognition.onerror = (event) => {
        console.error("Speech recognition error:", event.error);
        botStatusEl.textContent = "Speech recognition error.";
    };
    
    recognition.onend = () => {
        // Restart recognition if game is still in progress
        if (gameInProgress) {
            recognition.start();
        }
    };

} else {
    instructionsDiv.textContent = "Sorry, your browser doesn't support Speech Recognition. This game requires it.";
    startButton.disabled = true;
}

// --- Main Functions ---
function initializeMap() {
    map = L.map(mapDiv).setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
}

async function setupGame() {
    loadingOverlay.classList.remove('hidden');
    startButton.disabled = true;
    botStatusEl.textContent = "Planning a trip...";

    try {
        const journey = await getJourneyFromAI();
        const { start, end } = journey;

        startCityEl.textContent = start.city;
        endCityEl.textContent = end.city;

        const startPoint = L.latLng(start.lat, start.lon);
        const endPoint = L.latLng(end.lat, end.lon);

        setupRouting(startPoint, endPoint);

    } catch (error) {
        console.error("Failed to setup game:", error);
        botStatusEl.textContent = "Error planning trip. Please try again.";
        loadingOverlay.classList.add('hidden');
        startButton.disabled = false;
    }
}

function setupRouting(startPoint, endPoint) {
    if (routingControl) {
        map.removeControl(routingControl);
    }

    routingControl = L.Routing.control({
        waypoints: [startPoint, endPoint],
        routeWhileDragging: false,
        addWaypoints: false,
        createMarker: () => null, // We'll create our own markers
        lineOptions: {
            styles: [{color: 'blue', opacity: 0.6, weight: 6}]
        }
    }).addTo(map);

    routingControl.on('routesfound', function(e) {
        const routes = e.routes;
        if (routes.length === 0) {
             botStatusEl.textContent = "Could not find a route. Please restart.";
             loadingOverlay.classList.add('hidden');
             startButton.disabled = false;
             return;
        }
        
        const route = routes[0];
        routeInstructions = route.instructions;
        routeCoordinates = route.coordinates;

        // Reset and setup game elements
        if(botMarker) map.removeLayer(botMarker);
        if(traveledPath) map.removeLayer(traveledPath);

        botMarker = L.marker(startPoint, { icon: botIcon }).addTo(map);
        traveledPath = L.polyline([], {color: 'green', weight: 7, opacity: 0.8}).addTo(map);
        traveledPath.addLatLng(startPoint);
        
        map.fitBounds(route.summary.totalBounds, { padding: [50, 50] });

        instructionsDiv.classList.add('hidden');
        gameInfoDiv.classList.remove('hidden');
        
        currentStep = 0;
        gameInProgress = true;
        isBotMoving = false;
        
        updateInstruction();
        botStatusEl.textContent = "Ready for your first command!";
        loadingOverlay.classList.add('hidden');
        if (recognition) recognition.start();
    });
}

function updateInstruction() {
    if (currentStep < routeInstructions.length) {
        const instruction = routeInstructions[currentStep].text;
        currentInstructionEl.textContent = instruction;
    } else {
        currentInstructionEl.textContent = "You've arrived!";
        botStatusEl.textContent = "Congratulations!";
        gameInProgress = false;
        if (recognition) recognition.stop();
        startButton.textContent = "Play Again";
        startButton.disabled = false;
    }
}

async function checkCommand(command) {
    if(isBotMoving) return;
    botStatusEl.textContent = "Thinking...";
    
    const currentInstructionText = routeInstructions[currentStep].text;

    try {
        const completion = await websim.chat.completions.create({
            messages: [{
                role: "system",
                content: `You are an AI assistant for a map game. The user gives a voice command to a bot. The bot has a current navigation instruction. Determine if the user's command is a reasonable match for the instruction. Respond with JSON: {"match": boolean}. For example, if instruction is "Turn left onto Main Street" and user says "okay turn left", that's a match. If user says "go straight", it's not a match. If user says "go" or "start", it is a match for the first instruction ("Head north...").`
            }, {
                role: "user",
                content: `Instruction: "${currentInstructionText}". User command: "${command}"`,
                json: true
            }]
        });

        const result = JSON.parse(completion.content);

        if (result.match) {
            botStatusEl.textContent = "Okay, moving!";
            moveBotToNextStep();
        } else {
            botStatusEl.textContent = "That's not the right command. Try again.";
        }
    } catch(e) {
        console.error("AI check error:", e);
        botStatusEl.textContent = "Error understanding command. Try again.";
    }
}

function moveBotToNextStep() {
    isBotMoving = true;
    const nextInstruction = routeInstructions[currentStep];
    const targetCoordIndex = nextInstruction.index;
    
    const startingCoordIndex = (currentStep > 0) ? routeInstructions[currentStep - 1].index : 0;
    
    const pathSegment = routeCoordinates.slice(startingCoordIndex, targetCoordIndex + 1);

    let currentPathIndex = 0;
    const move = () => {
        if (currentPathIndex < pathSegment.length) {
            const nextLatLng = pathSegment[currentPathIndex];
            botMarker.setLatLng(nextLatLng);
            traveledPath.addLatLng(nextLatLng);
            currentPathIndex++;
            setTimeout(move, 50); // Animation speed
        } else {
            isBotMoving = false;
            currentStep++;
            updateInstruction();
             if (gameInProgress) {
                botStatusEl.textContent = "Awaiting next command...";
            }
        }
    };
    move();
}


async function getJourneyFromAI() {
    const completion = await websim.chat.completions.create({
        messages: [{
            role: "system",
            content: `You are a travel planner. Pick a random continent (from Africa, Asia, Europe, North America, South America, Oceania). Then, pick two different major cities from that continent. Provide the result as JSON with this schema: {"start": {"city": "City, Country", "lat": number, "lon": number}, "end": {"city": "City, Country", "lat": number, "lon": number}}. Do not add any other text.`
        }, {
            role: "user",
            content: "Give me a new random journey.",
            json: true
        }],
    });
    return JSON.parse(completion.content);
}


// --- Event Listeners ---
startButton.addEventListener('click', () => {
    if (gameInProgress) { // "Play Again" functionality
        gameInProgress = false;
        if(recognition) recognition.stop();
    }
    setupGame();
});

// --- Initialization ---
initializeMap();

