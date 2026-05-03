
const fs = require('fs');
const path = require('path');

// Simulate the "broken" autocomplete.js content (pre-fix)
const brokenAutocompleteCode = `
(function () {
  function createController(opts) {
    function getVars() { return opts.variables || []; }
    function requestVars() { if (opts.onRequestVariables) opts.onRequestVariables(); }
    function close() {}
    
    function update() {
      const vars = getVars();
      // THE BUG: If vars is empty, it calls requestVars()
      if (!vars.length) { 
        requestVars(); 
        close(); 
        return; 
      }
    }
    return { update: update };
  }
  return { createController: createController };
})()
`;

// Simulate the "fixed" autocomplete.js content (post-fix)
const fixedAutocompleteCode = `
(function () {
  function createController(opts) {
    function getVars() { return opts.variables || []; }
    function requestVars() { if (opts.onRequestVariables) opts.onRequestVariables(); }
    function close() {}
    
    function update() {
      const vars = getVars();
      // THE FIX: If vars is empty, just close. Don't trigger a new request.
      if (!vars.length) { 
        close(); 
        return; 
      }
    }
    return { update: update };
  }
  return { createController: createController };
})()
`;

function runTest(name, code) {
    console.log(`\n--- Testing ${name} ---`);
    let requestCount = 0;
    const variables = [];
    
    // Load the code
    const factory = eval(code);

    // Mock for the controller options
    const opts = {
        variables: variables,
        onRequestVariables: () => {
            requestCount++;
            console.log(`[Test] requestVariables called (Total: ${requestCount})`);
            
            // Simulate the extension responding with an empty list
            // In a real webview, this happens asynchronously.
            // We simulate the feedback loop by calling update() again.
            if (requestCount < 5) {
                console.log(`[Test] Simulating extension response with empty list -> calling update()...`);
                // Use process.nextTick to simulate async behavior
                process.nextTick(() => controller.update());
            } else {
                console.log(`[Test] Stopping simulation at 5 requests to avoid actual infinite loop in test.`);
            }
        }
    };

    const controller = factory.createController(opts);

    // Initial trigger (e.g. from boot or first update)
    console.log(`[Test] Triggering initial update...`);
    controller.update();
}

runTest('BROKEN VERSION', brokenAutocompleteCode);

setTimeout(() => {
    runTest('FIXED VERSION', fixedAutocompleteCode);
}, 500);
