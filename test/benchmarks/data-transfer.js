const { tableToIPC, tableFromIPC, tableFromArrays } = require('apache-arrow');
const { performance } = require('perf_hooks');

function generateData(rows, cols) {
    const data = {};
    for (let j = 0; j < cols; j++) {
        const colName = `col_${j}`;
        data[colName] = new Float64Array(rows).fill(Math.random());
    }
    return data;
}

function benchmark() {
    const ROW_COUNT = 100000;
    const COL_COUNT = 20;

    console.log(`Benchmarking ${ROW_COUNT} rows x ${COL_COUNT} columns...`);

    const rawData = generateData(ROW_COUNT, COL_COUNT);
    const table = tableFromArrays(rawData);

    // --- JSON Baseline ---
    // In VS Code, postMessage uses structured clone, which is faster than stringify/parse
    // but we'll use stringify/parse as a proxy for the total overhead if it were plain HTTP,
    // and just JSON.parse(JSON.stringify(obj)) to simulate the clone overhead for a plain object.

    // Convert table to array of arrays (what the webview previously received)
    const rowsArray = [];
    const colNames = Object.keys(rawData);
    for (let i = 0; i < ROW_COUNT; i++) {
        const row = [];
        for (let j = 0; j < COL_COUNT; j++) {
            row.push(rawData[colNames[j]][i]);
        }
        rowsArray.push(row);
    }
    const jsonObj = { vars: colNames, rows: rowsArray };

    const startJSON = performance.now();
    const jsonStr = JSON.stringify(jsonObj);
    const jsonParsed = JSON.parse(jsonStr);
    // Simulate rendering 100 rows
    const jsonRenderedRows = [];
    for (let i = 0; i < 100; i++) {
        jsonRenderedRows.push(jsonParsed.rows[i]);
    }
    const endJSON = performance.now();
    console.log(`JSON (Transfer+Parse+Render100): ${(endJSON - startJSON).toFixed(2)}ms, Size: ${(jsonStr.length / 1024 / 1024).toFixed(2)}MB`);

    // --- Arrow IPC ---
    const startArrow = performance.now();
    const arrowBuffer = tableToIPC(table);
    const parsedTable = tableFromIPC(arrowBuffer);
    // Simulate rendering 100 rows
    const arrowRenderedRows = [];
    for (let i = 0; i < 100; i++) {
        const row = [];
        for (let j = 0; j < parsedTable.numCols; j++) {
            row.push(parsedTable.getChildAt(j).get(i));
        }
        arrowRenderedRows.push(row);
    }
    const endArrow = performance.now();

    console.log(`Arrow (Transfer+Parse+Render100): ${(endArrow - startArrow).toFixed(2)}ms, Size: ${(arrowBuffer.length / 1024 / 1024).toFixed(2)}MB`);

    const speedup = (endJSON - startJSON) / (endArrow - startArrow);
    console.log(`Speedup (First 100 rows from ${ROW_COUNT}): ${speedup.toFixed(2)}x`);
}

try {
    benchmark();
} catch (err) {
    console.error(err);
}
