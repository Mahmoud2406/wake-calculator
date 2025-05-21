import React, { useState } from 'react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import './App.css';

const DEFAULTS = {
  width: 0.1, // m
  height: 0.089, // m
  area: 0.0089, // m^2
  U_stream: 10, // m/s
  P_tot_stream: 104800, // Pa
  rho: 1.225, // kg/m^3
};

function interpolatePressure(data, y, colNames) {
  // Linear interpolation for a given y (z in mm)
  // colNames: array of column names to interpolate between
  // data: array of objects from CSV
  // y: target y (z in mm)
  // Returns: interpolated pressure for each colName
  const results = {};
  colNames.forEach((col) => {
    let lower = null, upper = null;
    for (let i = 0; i < data.length; i++) {
      const z = parseFloat(data[i]['z (mm)']);
      if (z <= y && (!lower || z > parseFloat(lower['z (mm)']))) lower = data[i];
      if (z >= y && (!upper || z < parseFloat(upper['z (mm)']))) upper = data[i];
    }
    if (lower && upper && lower !== upper) {
      const z1 = parseFloat(lower['z (mm)']);
      const z2 = parseFloat(upper['z (mm)']);
      const p1 = parseFloat(lower[col]);
      const p2 = parseFloat(upper[col]);
      results[col] = p1 + (p2 - p1) * (y - z1) / (z2 - z1);
    } else if (lower) {
      results[col] = parseFloat(lower[col]);
    } else if (upper) {
      results[col] = parseFloat(upper[col]);
    } else {
      results[col] = null;
    }
  });
  return results;
}

function calculateWakeVelocities(P_tot_stream, P_tot_wake, U_stream, rho) {
  // Bernoulli: U_wake = sqrt(2*(P_tot_stream - P_tot_wake)/rho + U_stream^2)
  return Math.sqrt(Math.max(0, 2 * (P_tot_stream - P_tot_wake) / rho + U_stream ** 2));
}

function App() {
  const [csvData, setCsvData] = useState([]);
  const [results, setResults] = useState(null);
  const [constants, setConstants] = useState(DEFAULTS);
  const [uploadedFileName, setUploadedFileName] = useState('');
  const [showPreview, setShowPreview] = useState(false);

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploadedFileName(file.name);
    setShowPreview(true);
    const fileName = file.name.toLowerCase();
    if (fileName.endsWith('.csv')) {
      Papa.parse(file, {
        header: true,
        dynamicTyping: true,
        complete: (res) => setCsvData(res.data.filter(row => row['z (mm)'] !== undefined && row['z (mm)'] !== '')),
      });
    } else if (fileName.endsWith('.xlsx')) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const data = new Uint8Array(evt.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
        setCsvData(jsonData.filter(row => row['z (mm)'] !== undefined && row['z (mm)'] !== ''));
      };
      reader.readAsArrayBuffer(file);
    }
  };

  const handleRemoveFile = () => {
    setUploadedFileName('');
    setCsvData([]);
    setShowPreview(false);
    setResults(null);
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setConstants((prev) => ({
      ...prev,
      [name]: parseFloat(value),
    }));
  };

  const handleCalculate = () => {
    if (csvData.length === 0) {
      setResults({
        error: 'Du må laste opp en CSV- eller Excel-fil før du kan beregne.'
      });
      return;
    }

    // 1. Sort data by 'z (mm)'
    const sortedData = [...csvData].sort((a, b) => parseFloat(a['z (mm)']) - parseFloat(b['z (mm)']));

    // 2. Interpolate pressures at y = 10 mm
    const y = 10;
    const header = Object.keys(sortedData[0]);
    const colNames = header.filter(h => h.startsWith('P_stat_y_'));
    const interpStatic = interpolatePressure(sortedData, y, colNames);
    const interpTotal = interpolatePressure(sortedData, y, ['P_tot_stream']);
    let wakePressureCol;
    if (header.includes('P_tot_y_10')) {
      wakePressureCol = 'P_tot_y_10';
    } else {
      wakePressureCol = header.find(h => h.startsWith('P_tot_y_'));
    }

    // Validate constants
    if (constants.U_stream <= 0 || constants.area <= 0 || constants.rho <= 0) {
      setResults({
        error: 'Ugyldige konstanter: U_stream, area og rho må være positive tall.'
      });
      return;
    }

    // Validate P_tot_stream > all P_tot_wake
    const anyWakeGreater = sortedData.some(row => parseFloat(row[wakePressureCol]) >= constants.P_tot_stream);
    if (anyWakeGreater) {
      setResults({
        error: 'P_tot_stream må være større enn alle P_tot_wake-verdier i datasettet. Sjekk filen og konstanter.'
      });
      return;
    }

    // --- Fix: Correct negative P_tot_y_* values if needed ---
    // If all P_tot_y_* values are negative and P_atm exists, add P_atm to all P_tot_y_* columns
    const pAtmCol = header.find(h => h === 'P_atm (Pa)' || h === 'P_atm');
    if (pAtmCol) {
      const allNegative = sortedData.every(row => parseFloat(row[wakePressureCol]) < 0);
      if (allNegative) {
        const pAtmVal = parseFloat(sortedData[0][pAtmCol]);
        sortedData.forEach(row => {
          header.filter(h => h.startsWith('P_tot_y_')).forEach(col => {
            if (parseFloat(row[col]) < 0) {
              row[col] = parseFloat(row[col]) + pAtmVal;
            }
          });
        });
      }
    }
    // --- End fix ---
    // 3. Calculate wake velocities, area elements, and momentum loss
    let totalMomentumLoss = 0;
    let wakeVelocities = [];
    let areaElements = [];
    let interpolatedPressures = [];
    for (let i = 0; i < sortedData.length - 1; i++) {
      const row = sortedData[i];
      const nextRow = sortedData[i + 1];
      const dzLocal = Math.abs(parseFloat(nextRow['z (mm)']) - parseFloat(row['z (mm)'])) / 1000; // mm to m
      const dA = constants.width * dzLocal;
      const P_tot_wake = parseFloat(row[wakePressureCol]);
      const U_wake = Math.sqrt(Math.max(0, 2 * (constants.P_tot_stream - P_tot_wake) / constants.rho + Math.pow(constants.U_stream, 2)));
      const momentumLoss = constants.rho * U_wake * (constants.U_stream - U_wake) * dA;
      totalMomentumLoss += Math.abs(momentumLoss); // Use absolute value for each segment
      wakeVelocities.push(U_wake);
      areaElements.push(dA);
      interpolatedPressures.push(P_tot_wake);
    }
    // Handle last row
    if (sortedData.length > 1) {
      const lastRow = sortedData[sortedData.length - 1];
      const dzLast = Math.abs(parseFloat(sortedData[sortedData.length - 1]['z (mm)']) - parseFloat(sortedData[sortedData.length - 2]['z (mm)'])) / 1000;
      const dA = constants.width * dzLast;
      const P_tot_wake = parseFloat(lastRow[wakePressureCol]);
      const U_wake = Math.sqrt(Math.max(0, 2 * (constants.P_tot_stream - P_tot_wake) / constants.rho + Math.pow(constants.U_stream, 2)));
      const momentumLoss = constants.rho * U_wake * (constants.U_stream - U_wake) * dA;
      totalMomentumLoss += Math.abs(momentumLoss); // Use absolute value for last segment
      wakeVelocities.push(U_wake);
      areaElements.push(dA);
      interpolatedPressures.push(P_tot_wake);
    }
    // 4. Compute drag
    const totalDrag = totalMomentumLoss;
    // 5. Compute drag coefficient
    const C_D = totalDrag / (0.5 * constants.rho * Math.pow(constants.U_stream, 2) * constants.area);
    // 6. Compute SCD
    const SCD = C_D * constants.area;

    // Robust C_D check
    if (!isFinite(C_D)) {
      setResults({
        error: 'Ugyldig dragkoeffisient (C_D). Sjekk at alle konstanter og data er riktige.'
      });
      return;
    }

    setResults({
      interpolatedPressures,
      wakeVelocities,
      areaElements,
      totalMomentumLoss,
      totalDrag,
      C_D,
      SCD,
      interpTotal,
      interpStatic
    });
  };

  return (
    <div className="app-container" style={{
      minHeight: '100vh',
      width: '100vw',
      background: 'linear-gradient(120deg, #181c24 0%, #232733 100%)',
      color: '#e0e7ef',
      fontFamily: 'Fira Mono, Menlo, Consolas, monospace',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-start',
      padding: 0,
      boxSizing: 'border-box',
    }}>
      <header style={{
        width: '100%',
        background: '#1a1e27',
        borderBottom: '1px solid #232733',
        padding: '24px 0 12px 0',
        textAlign: 'center',
        boxShadow: '0 2px 12px #0002',
        marginBottom: 0
      }}>
        <h1 className="main-title" style={{
          fontSize: 36,
          fontWeight: 800,
          letterSpacing: 1.2,
          color: '#7dd3fc',
          margin: 0,
          fontFamily: 'Fira Mono, Menlo, Consolas, monospace',
        }}>Wake Calculator</h1>
        <span style={{ color: '#b3b9c9', fontSize: 16, fontWeight: 400 }}>Wind Tunnel Wake Measurement Analysis</span>
      </header>
      <main style={{
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'flex-start',
        width: '100%',
        maxWidth: 1400,
        margin: '0 auto',
        gap: 40,
        padding: '32px 0 64px 0',
        flex: 1
      }}>
        <section className="main-card" style={{
          background: '#232733',
          borderRadius: 18,
          boxShadow: '0 6px 32px #0006',
          padding: 36,
          minWidth: 420,
          maxWidth: '70%',
          width: '70%',
          flexBasis: '70%',
          flexGrow: 1,
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 24,
        }}>
          <div className="file-upload modern-upload" style={{ width: '100%' }}>
            <label htmlFor="file-upload-input" className="file-upload-label" style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: '#181c24',
              border: '1.5px solid #2d3340',
              borderRadius: 8,
              padding: '10px 18px',
              cursor: 'pointer',
              fontWeight: 600,
              color: '#7dd3fc',
              fontSize: 17,
              marginBottom: 8
            }}>
              <span className="file-upload-icon" style={{ fontSize: 22 }}>📄</span>
              <span>Last opp CSV- eller Excel-fil</span>
            </label>
            <input
              id="file-upload-input"
              type="file"
              accept=".csv,.xlsx"
              onChange={handleFileUpload}
              className="file-upload-input"
              style={{ display: 'none' }}
            />
            {uploadedFileName && (
              <div className="file-upload-success" aria-live="polite" style={{
                color: '#22d3ee',
                fontWeight: 600,
                marginTop: 4,
                fontSize: 15,
                display: 'flex',
                alignItems: 'center',
                gap: 8
              }}>
                <span className="file-upload-success-icon" aria-hidden="true">✔️</span>
                <span className="file-upload-success-text">{uploadedFileName} er lastet opp</span>
              </div>
            )}
          </div>
          <div className="excel-syntax-box" style={{
            background: '#181c24',
            border: '1.5px solid #2d3340',
            borderRadius: 10,
            padding: '18px 18px 10px 18px',
            width: '100%',
            marginBottom: 0,
            color: '#e0e7ef',
            fontSize: 15,
            boxShadow: '0 2px 8px #0002',
          }}>
            <div className="excel-syntax-header" style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
              fontWeight: 700,
              color: '#7dd3fc',
              fontSize: 16
            }}>
              <span>Eksempel på Excel/CSV-format</span>
              <button className="close-preview-btn" onClick={handleRemoveFile} aria-label="Fjern forhåndsvisning" style={{
                background: 'none',
                border: 'none',
                color: '#e0e7ef',
                fontSize: 22,
                cursor: 'pointer',
                fontWeight: 700,
                marginLeft: 8
              }}>×</button>
            </div>
            <div className="excel-syntax-desc" style={{ color: '#b3b9c9', marginBottom: 8, background: '#232733', borderRadius: 6, padding: '10px 12px', border: '1px solid #2d3340' }}>
              <strong>Obligatoriske kolonner:</strong> <br />
              <span className="excel-col" style={{ color: '#7dd3fc' }}>z (mm)</span>, <span className="excel-col" style={{ color: '#7dd3fc' }}>P_tot_y_10</span> (eller tilsvarende), <span className="excel-col" style={{ color: '#7dd3fc' }}>P_stat_y_0</span> (eller tilsvarende).<br />
              <span className="excel-col" style={{ color: '#7dd3fc' }}>P_tot_stream</span> og <span className="excel-col" style={{ color: '#7dd3fc' }}>U_stream</span> bør være med som konstanter eller i skjemaet.<br />
              <span className="excel-col" style={{ color: '#7dd3fc' }}>width</span>, <span className="excel-col" style={{ color: '#7dd3fc' }}>height</span>, <span className="excel-col" style={{ color: '#7dd3fc' }}>area</span>, <span className="excel-col" style={{ color: '#7dd3fc' }}>rho</span> kan fylles ut i skjemaet eller legges til i filen.
            </div>
            {showPreview && csvData.length > 0 && (
              <div className="excel-preview-table" style={{ maxHeight: 320, overflow: 'auto', width: '100%', borderRadius: 6, border: '1px solid #232733', background: '#232733', marginTop: 8 }}>
                <table className="preview-table" style={{ borderCollapse: 'collapse', width: 'max-content', minWidth: '100%', fontSize: 14, background: '#232733', color: '#e0e7ef' }}>
                  <thead>
                    <tr>
                      {Object.keys(csvData[0]).map((key) => (
                        <th key={key} style={{ border: '1px solid #2d3340', padding: '4px 8px', background: '#181c24', fontWeight: 600, color: '#7dd3fc', position: 'sticky', top: 0, zIndex: 1, whiteSpace: 'nowrap' }}>{key}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {csvData.slice(0, 20).map((row, idx) => (
                      <tr key={idx}>
                        {Object.keys(csvData[0]).map((key) => (
                          <td key={key} style={{ border: '1px solid #232733', padding: '4px 8px', background: idx % 2 === 0 ? '#232733' : '#181c24', color: '#e0e7ef', whiteSpace: 'nowrap' }}>{row[key]}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="inputs-grid" style={{
            marginTop: '1.5rem',
            marginBottom: '1.5rem',
            width: '100%',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 18,
            background: '#181c24',
            borderRadius: 10,
            padding: '18px 18px 8px 18px',
            border: '1.5px solid #2d3340',
            color: '#e0e7ef',
            fontSize: 15,
          }}>
            {Object.keys(DEFAULTS).map((key) => (
              <label key={key} className="input-label" style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                fontWeight: 600,
                color: '#7dd3fc',
                fontSize: 15
              }}>
                <span>{key.replace(/_/g, ' ')}</span>
                <input
                  type="number"
                  name={key}
                  value={constants[key]}
                  onChange={handleChange}
                  step="any"
                  className="input-field"
                  style={{
                    background: '#232733',
                    border: '1.5px solid #2d3340',
                    borderRadius: 6,
                    color: '#e0e7ef', // Lighter text for better contrast
                    fontSize: 15,
                    padding: '6px 10px',
                    fontFamily: 'Fira Mono, Menlo, Consolas, monospace',
                    fontWeight: 700,
                    letterSpacing: 0.2,
                  }}
                />
              </label>
            ))}
            <br />
          </div>
          <button className="main-btn" onClick={handleCalculate} style={{
            background: 'linear-gradient(90deg, #7dd3fc 0%, #38bdf8 100%)',
            color: '#181c24',
            fontWeight: 800,
            fontSize: 18,
            border: 'none',
            borderRadius: 8,
            padding: '12px 0',
            width: '100%',
            marginTop: 8,
            marginBottom: 0,
            cursor: 'pointer',
            boxShadow: '0 2px 8px #0002',
            letterSpacing: 0.5
          }}>
            Beregn
          </button>
          {results && results.error && (
            <div className="error-message" style={{
              background: '#3b1c1c',
              color: '#f87171',
              border: '1.5px solid #7f1d1d',
              borderRadius: 8,
              padding: '10px 16px',
              marginTop: 10,
              fontWeight: 600,
              fontSize: 15
            }}>{results.error}</div>
          )}
          {results && !results.error && (
            <div className="results-section" style={{
              background: '#181c24',
              border: '1.5px solid #2d3340',
              borderRadius: 12,
              padding: '18px 18px 10px 18px',
              width: '100%',
              marginTop: 0,
              color: '#e0e7ef',
              fontSize: 15,
              boxShadow: '0 2px 8px #0002',
            }}>
              <h2 className="results-title" style={{ color: '#7dd3fc', fontWeight: 700, fontSize: 20, marginBottom: 12 }}>Resultater</h2>
              <div className="results-grid" style={{
                display: 'flex',
                flexDirection: 'row',
                gap: 18,
                marginBottom: 12,
                flexWrap: 'wrap',
              }}>
                <div className="result-card" style={{
                  background: '#232733',
                  border: '1.5px solid #2d3340',
                  borderRadius: 8,
                  padding: '12px 18px',
                  minWidth: 120,
                  textAlign: 'center',
                  color: '#7dd3fc',
                  fontWeight: 700,
                  fontSize: 16
                }}>
                  <div className="result-label" style={{ color: '#b3b9c9', fontWeight: 600, fontSize: 14 }}>Drag</div>
                  <div className="result-value">{results.totalDrag.toFixed(4)} N</div>
                </div>
                <div className="result-card" style={{
                  background: '#232733',
                  border: '1.5px solid #2d3340',
                  borderRadius: 8,
                  padding: '12px 18px',
                  minWidth: 120,
                  textAlign: 'center',
                  color: '#7dd3fc',
                  fontWeight: 700,
                  fontSize: 16
                }}>
                  <div className="result-label" style={{ color: '#b3b9c9', fontWeight: 600, fontSize: 14 }}>Drag Coefficient (C_D)</div>
                  <div className="result-value">{results.C_D.toFixed(4)}</div>
                </div>
                <div className="result-card" style={{
                  background: '#232733',
                  border: '1.5px solid #2d3340',
                  borderRadius: 8,
                  padding: '12px 18px',
                  minWidth: 120,
                  textAlign: 'center',
                  color: '#7dd3fc',
                  fontWeight: 700,
                  fontSize: 16
                }}>
                  <div className="result-label" style={{ color: '#b3b9c9', fontWeight: 600, fontSize: 14 }}>SCD</div>
                  <div className="result-value">{results.SCD.toFixed(6)}</div>
                </div>
              </div>
              <div className="results-list" style={{ marginBottom: 8 }}>
                <strong style={{ color: '#7dd3fc' }}>Wake Velocities (m/s):</strong>
                <div className="results-scroll" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'nowrap', marginTop: '0.3rem', overflowX: 'auto', background: '#232733', borderRadius: '6px', padding: '8px 6px', border: '1px solid #2d3340', boxShadow: '0 1px 4px #0002 inset', color: '#38bdf8', fontSize: '0.98rem', minWidth: '100%' }}>
                  {results.wakeVelocities.map((v, i) => (
                    <span key={i} className="results-item">{v.toFixed(2)}</span>
                  ))}
                </div>
              </div>
              <div className="results-list">
                <strong style={{ color: '#7dd3fc' }}>Area Elements (m²):</strong>
                <div className="results-scroll" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'nowrap', marginTop: '0.3rem', overflowX: 'auto', background: '#232733', borderRadius: '6px', padding: '8px 6px', border: '1px solid #2d3340', boxShadow: '0 1px 4px #0002 inset', color: '#38bdf8', fontSize: '0.98rem', minWidth: '100%' }}>
                  {results.areaElements.map((a, i) => (
                    <span key={i} className="results-item">{a.toExponential(2)}</span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
        {/* Centered instructions panel with modern style */}
        <aside className="instructions-panel" style={{
          minWidth: 340,
          maxWidth: '30%',
          width: '30%',
          flexBasis: '30%',
          flexGrow: 0,
          margin: '0',
          alignSelf: 'flex-start',
          background: '#232733',
          borderRadius: 18,
          boxShadow: '0 6px 32px #0006',
          padding: 32,
          fontSize: 16,
          color: '#e0e7ef',
          textAlign: 'center',
          position: 'relative',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 2,
          marginBottom: 32,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 18
        }}>
          <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 18, textAlign: 'center', letterSpacing: 0.2, color: '#7dd3fc' }}>Python Wake Calculation</h2>
          <div style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
            <CollapsibleBlock
              title="1. Sorter data etter z (mm)"
              code={`data = sorted(data, key=lambda row: float(row['z (mm)']))`}
            />
            <CollapsibleBlock
              title="2. Korriger negative totaltrykk hvis nødvendig"
              code={`if all(float(row['P_tot_y_10']) < 0 for row in data):\n    p_atm = float(data[0]['P_atm (Pa)'])\n    for row in data:\n        row['P_tot_y_10'] += p_atm`}
            />
            <CollapsibleBlock
              title="3. Beregn dA for hvert segment"
              code={`dA = [width * abs(float(data[i+1]['z (mm)']) - float(data[i]['z (mm)']))/1000\n      for i in range(len(data)-1)]`}
            />
            <CollapsibleBlock
              title="4. Beregn U_wake for hver rad"
              code={`U_wake = [ (2*(P_tot_stream - float(row['P_tot_y_10']))/rho + U_stream**2)**0.5\n      for row in data ]`}
            />
            <CollapsibleBlock
              title="5. Beregn momentum loss for hvert segment"
              code={`momentum_loss = [ rho * U_wake[i] * (U_stream - U_wake[i]) * dA[i]\n      for i in range(len(dA)) ]`}
            />
            <CollapsibleBlock
              title="6. Summer absoluttverdier for total drag"
              code={`D = sum(abs(m) for m in momentum_loss)`}
            />
            <CollapsibleBlock
              title="7. Beregn dragkoeffisient (C_D)"
              code={`C_D = D / (0.5 * rho * U_stream**2 * area)`}
            />
          </div>
          <div style={{ fontSize: '1em', color: '#b3b9c9', marginTop: 24, textAlign: 'center', maxWidth: 420 }}>
            <b style={{ color: '#7dd3fc' }}>Python-algoritme:</b><br />
            <span style={{ color: '#b3b9c9' }}>1. Sorter data etter z (mm)</span><br />
            <span style={{ color: '#b3b9c9' }}>2. Korriger negative totaltrykk hvis nødvendig</span><br />
            <span style={{ color: '#b3b9c9' }}>3. Beregn dA for hvert segment</span><br />
            <span style={{ color: '#b3b9c9' }}>4. Beregn U_wake for hver rad</span><br />
            <span style={{ color: '#b3b9c9' }}>5. Beregn momentum loss for hvert segment</span><br />
            <span style={{ color: '#b3b9c9' }}>6. Summer absoluttverdier for total drag</span><br />
            <span style={{ color: '#b3b9c9' }}>7. Beregn dragkoeffisient (C_D)</span>
          </div>
        </aside>
      </main>
      <footer className="footer" style={{
        width: '100%',
        background: '#181c24',
        color: '#7dd3fc',
        textAlign: 'center',
        fontWeight: 600,
        fontSize: 15,
        padding: '18px 0 10px 0',
        borderTop: '1.5px solid #232733',
        boxShadow: '0 -2px 12px #0002',
        marginTop: 'auto',
        letterSpacing: 0.5
      }}>
        Wake Calculator &copy; 2025<br />Author: Tsegay Habtegebriel Tekle
      </footer>
    </div>
  );
}

// Collapsible Python code block component
function CollapsibleBlock({ title, code }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ width: '100%', margin: '0 auto', background: '#232733', borderRadius: 10, boxShadow: '0 2px 8px #0004', marginBottom: 8 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%',
          background: 'none',
          border: 'none',
          color: '#f3f6fa',
          fontWeight: 600,
          fontSize: 16,
          textAlign: 'left',
          padding: '12px 18px',
          borderRadius: 10,
          cursor: 'pointer',
          outline: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 10
        }}
        aria-expanded={open}
        aria-controls={title.replace(/\s/g, '-') + '-block'}
      >
        <span style={{ fontSize: 18, marginRight: 8 }}>{open ? '▼' : '▶'}</span>
        {title}
      </button>
      {open && (
        <pre
          id={title.replace(/\s/g, '-') + '-block'}
          style={{
            background: '#181c24',
            color: '#e0e7ef',
            fontFamily: 'Fira Mono, Menlo, Consolas, monospace',
            fontSize: 15,
            padding: '16px 18px',
            borderRadius: 10,
            margin: 0,
            border: '1px solid #2d3340',
            overflowX: 'auto',
            whiteSpace: 'pre',
            textAlign: 'left',
            marginTop: -6
          }}
        >{code}</pre>
      )}
    </div>
  );
}

export default App;
