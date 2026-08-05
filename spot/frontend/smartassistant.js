// Voice Assistant Integration.
// Theme handling now lives in bridge-shell.js so every page shares it.
function startwwd() {
    // Start the voice assistant
    if (typeof startAssistant === 'function') {
        startAssistant();
    } else {
        console.error('Voice assistant not loaded');
        if (window.BridgeUI) {
            window.BridgeUI.toast('Voice assistant is not available. Please refresh the page.', 'bad');
        } else {
            alert('Voice assistant is not available. Please refresh the page.');
        }
    }
}
