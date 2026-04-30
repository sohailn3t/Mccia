import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import Papa from "papaparse";
import { format, subWeeks, parseISO } from "date-fns";
import multer from "multer";

const app = express();
const PORT = 3000;

// Multer setup for memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Types
interface SalesRow {
  sku_id: string;
  outlet_id: string;
  week_date: string;
  units_sold: number;
}

interface SKU {
  sku_id: string;
  product_name: string;
  sku_name?: string; // Fallback
  brand: string;
  category: string;
  moq: number;
  shelf_life_days: number;
  lead_time_days: number;
}

interface Inventory {
  sku_id: string;
  warehouse_stock: number;
  in_transit_qty: number;
  committed_qty: number;
}

interface Promo {
  sku_id: string;
  week_date: string;
  promo_uplift_factor: number;
}

interface Festival {
  week_date: string;
  festival_name: string;
}

// Utility to create a header mapper to avoid O(N) lookups per row
const createHeaderMapper = (sampleRow: any) => {
  const aliases: Record<string, string[]> = {
    sku_id: ['sku_id', 'sku', 'sku_code', 'SKU', 'SKU_ID', 'SKU ID'],
    week_date: ['week_date', 'week_start_date', 'date', 'week', 'Week', 'Week_Start_Date'],
    units_sold: ['units_sold', 'quantity', 'units', 'sales', 'Sales', 'Quantity'],
    product_name: ['product_name', 'sku_name', 'name', 'Name', 'Product_Name'],
    moq: ['moq', 'moq_from_supplier', 'MOQ', 'moq_from_origin'],
    lead_time_days: ['lead_time_days', 'lead_time', 'supplier_lead_time_days', 'lead_days'],
    shelf_life_days: ['shelf_life_days', 'shelf_life', 'expiry_days', 'shelflife'],
    warehouse_stock: ['warehouse_stock', 'warehouse', 'Warehouse_Stock', 'wh_stock'],
    in_transit_qty: ['in_transit_qty', 'in_transit', 'In_Transit_Qty', 'it_stock'],
    committed_qty: ['committed_qty', 'committed', 'Committed_Qty', 'res_stock'],
    promo_uplift_factor: ['promo_uplift_factor', 'uplift', 'promo_uplift'],
    festival_name: ['festival_name', 'event', 'festival']
  };

  const mapping: Record<string, string> = {};
  Object.keys(sampleRow).forEach(key => {
    const targetKey = Object.keys(aliases).find(target => 
      target === key.toLowerCase() || aliases[target].includes(key)
    );
    if (targetKey) {
      mapping[key] = targetKey;
    }
  });
  return mapping;
};

// Utility to parse buffer to CSV with optimized normalization
const parseCSVBuffer = <T>(buffer: Buffer): T[] => {
  const content = buffer.toString("utf8");
  const parsed = Papa.parse(content, { header: true, dynamicTyping: true, skipEmptyLines: true });
  
  if (parsed.data.length === 0) return [];
  
  const mapping = createHeaderMapper(parsed.data[0]);
  
  return parsed.data.map((row: any) => {
    const normalized: any = {};
    for (const key in row) {
      const target = mapping[key];
      normalized[target || key] = row[key];
    }
    return normalized;
  }) as T[];
};

function performAnalysis(
  salesHistory: SalesRow[],
  skuMaster: SKU[],
  inventorySnapshot: Inventory[],
  promotionsCalendar: Promo[],
  festiveCalendar: Festival[]
) {
  // 1. Group sales by [SKU, Week] to get total weekly volume across ALL outlets
  const skuWeeklyTotals: Record<string, Record<string, number>> = {};
  
  salesHistory.forEach(row => {
    const skuId = String(row.sku_id || "").trim();
    const weekDate = String(row.week_date || "").trim();
    if (!skuId || !weekDate) return;

    if (!skuWeeklyTotals[skuId]) skuWeeklyTotals[skuId] = {};
    const units = Number(row.units_sold) || 0;
    skuWeeklyTotals[skuId][weekDate] = (skuWeeklyTotals[skuId][weekDate] || 0) + units;
  });

  // Pre-index inventories for O(1) lookup
  const inventoryMap = new Map<string, Inventory>();
  inventorySnapshot.forEach(inv => {
    const sid = String(inv.sku_id || "").trim();
    if (sid) inventoryMap.set(sid, inv);
  });

  // Pre-index promotions
  const promoMap = new Map<string, Set<string>>();
  promotionsCalendar.forEach(p => {
    const sid = String(p.sku_id || "").trim();
    const wdate = String(p.week_date || "").trim();
    if (!promoMap.has(sid)) promoMap.set(sid, new Set());
    promoMap.get(sid)!.add(wdate);
  });

  const diwaliDates = festiveCalendar
    .filter(f => f.festival_name && f.festival_name.toLowerCase().includes('diwali'))
    .map(f => String(f.week_date || "").trim());

  const results = skuMaster
    .filter(sku => sku && sku.sku_id)
    .map(sku => {
      const skuId = String(sku.sku_id).trim();
      const weeklyData = skuWeeklyTotals[skuId] || {};
      const volumes = Object.values(weeklyData).map(v => Number(v) || 0);
      
      // ERROR 1 FIX: Avg Weekly Sales 
      const avgWeeklySales = volumes.length > 0 
        ? volumes.reduce((a, b) => a + b, 0) / volumes.length 
        : 0;

      // ERROR 2 FIX: Available Stock formula using Map lookup
      const inv = inventoryMap.get(skuId) || { warehouse_stock: 0, in_transit_qty: 0, committed_qty: 0 } as Inventory;
      const warehouse = Number(inv.warehouse_stock) || 0;
      const inTransit = Number(inv.in_transit_qty) || 0;
      const committed = Number(inv.committed_qty) || 0;
      const available_stock = warehouse + inTransit - committed;

      // Weeks of Stock
      const weeks_of_stock_num = avgWeeklySales > 0 ? available_stock / avgWeeklySales : 999;
      const weeks_of_stock = available_stock <= 0 ? 'NEGATIVE' : Math.round(weeks_of_stock_num * 10) / 10;

      // ERROR 5 FIX: Seasonal Detection
      let classification = 'Standard';
      if (avgWeeklySales > 1000) classification = 'Fast-Moving';
      else if (avgWeeklySales < 50 && avgWeeklySales > 0) classification = 'Slow-Moving';
      else if (avgWeeklySales === 0) classification = 'Dead Stock';

      if (diwaliDates.length > 0 && avgWeeklySales > 0) {
        const diwaliVolumes = diwaliDates.map(d => Number(weeklyData[d]) || 0);
        const diwaliAvg = diwaliVolumes.reduce((a, b) => a + b, 0) / diwaliDates.length;
        if (diwaliAvg / avgWeeklySales > 1.5) classification = 'Seasonal';
      }

      // ERROR 3 & 6 FIX: Order Logic & Stockout Risk
      const leadWeeks = (Number(sku.lead_time_days) || 0) / 7;
      const safetyWeeks = 1.5;
      const reorderTrigger = leadWeeks + safetyWeeks;
      
      let urgency = 'OK';
      let stockout_risk = 'No';
      let raw_order = 0;

      if (available_stock <= 0) {
        urgency = 'CRITICAL';
        stockout_risk = 'CRITICAL';
        raw_order = (6 * avgWeeklySales) - available_stock;
      } else if (weeks_of_stock_num < leadWeeks) {
        urgency = 'URGENT';
        stockout_risk = 'URGENT';
        raw_order = (6 * avgWeeklySales) - available_stock;
      } else if (weeks_of_stock_num < reorderTrigger) {
        urgency = 'ORDER NOW';
        stockout_risk = 'WARNING';
        raw_order = (6 * avgWeeklySales) - available_stock;
      }

      // Apply MOQ rounding
      let order_quantity = 0;
      let moq_applied = false;
      if (raw_order > 0) {
        const moq = Number(sku.moq) || 1;
        order_quantity = Math.ceil(raw_order / moq) * moq;
        moq_applied = order_quantity > raw_order;
      }

      // Shelf life capping
      let shelf_life_capped = false;
      const shelfLifeWeeks = (Number(sku.shelf_life_days) || 0) / 7;
      if (shelfLifeWeeks > 0 && order_quantity > avgWeeklySales * shelfLifeWeeks) {
        order_quantity = Math.floor(avgWeeklySales * shelfLifeWeeks);
        shelf_life_capped = true;
      }

      const overstock = weeks_of_stock_num > 8;

      return {
        sku_id: skuId,
        product_name: sku.product_name || sku.sku_name || "Unknown Product",
        brand: sku.brand || "N/A",
        category: sku.category || "N/A",
        warehouse_stock: warehouse,
        in_transit_qty: inTransit,
        committed_qty: committed,
        available_stock,
        avg_weekly_sales: Math.round(avgWeeklySales),
        weeks_of_stock,
        classification,
        order_quantity,
        moq_applied,
        shelf_life_capped,
        urgency,
        stockout_risk,
        overstock,
        reorder_reason: urgency === 'OK' ? (overstock ? "Overstock: Current supply exceeds 8 weeks." : "Stock levels adequate.") : `${urgency}: Replenishing based on 6-week horizon.`
      };
    });

  return { results, diwaliStockouts: [] };
}

// API Health Check
app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// POST API for dynamic analysis
app.post("/api/analyze", upload.fields([
  { name: 'sales_history', maxCount: 1 },
  { name: 'inventory_snapshot', maxCount: 1 },
  { name: 'sku_master', maxCount: 1 },
  { name: 'promotions_calendar', maxCount: 1 },
  { name: 'festive_calendar', maxCount: 1 }
]), (req, res) => {
  try {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    if (!files || !files.sales_history || !files.inventory_snapshot || !files.sku_master) {
      return res.status(400).json({ error: "Missing required CSV files: Sales History, Inventory Snapshot, and SKU Master are mandatory." });
    }

    const ignoreErrors = req.body.ignoreErrors === "true";

    const salesHistory = parseCSVBuffer<SalesRow>(files.sales_history[0].buffer);
    const skuMaster = parseCSVBuffer<SKU>(files.sku_master[0].buffer);
    const inventorySnapshot = parseCSVBuffer<Inventory>(files.inventory_snapshot[0].buffer);

    if (!salesHistory.length || !skuMaster.length || !inventorySnapshot.length) {
      return res.status(400).json({ error: "One or more required CSV files are empty or could not be parsed." });
    }

    // Advanced Validation (After key normalization)
    const firstSales = (salesHistory[0] || {}) as any;
    const missing = [];
    if (!('sku_id' in firstSales)) missing.push('SKU ID');
    if (!('week_date' in firstSales)) missing.push('Week/Date');
    if (!('units_sold' in firstSales)) missing.push('Units Sold');

    if (missing.length && !ignoreErrors) {
      return res.status(400).json({ 
        error: `Validation Error: Could not find required data in columns [${missing.join(", ")}]. Please ensure your CSV has headers and data rows.`,
        isRecoverable: true 
      });
    }

    const promotionsCalendar = files.promotions_calendar ? parseCSVBuffer<Promo>(files.promotions_calendar[0].buffer) : [];
    const festiveCalendar = files.festive_calendar ? parseCSVBuffer<Festival>(files.festive_calendar[0].buffer) : [];

    const analysis = performAnalysis(salesHistory, skuMaster, inventorySnapshot, promotionsCalendar, festiveCalendar);
    console.log("Analysis completed successfully for", analysis.results.length, "SKUs");
    res.json(analysis);
  } catch (err: any) {
    console.error("ANALYSIS SERVER ERROR:", err);
    res.status(500).json({ 
      error: `Server Analysis Error: ${err.message || 'Unknown error'}. Please check your CSV data for inconsistencies.`,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// GET API for default snapshot
app.get("/api/analysis", (req, res) => {
  const loadCSV = <T>(filename: string): T[] => {
    const filePath = path.join(process.cwd(), "public", "data", filename);
    if (!fs.existsSync(filePath)) return [];
    const csvFile = fs.readFileSync(filePath, "utf8");
    return Papa.parse(csvFile, { header: true, dynamicTyping: true, skipEmptyLines: true }).data as T[];
  };
  const analysis = performAnalysis(
    loadCSV<SalesRow>("sales_history.csv"),
    loadCSV<SKU>("sku_master.csv"),
    loadCSV<Inventory>("inventory_snapshot.csv"),
    loadCSV<Promo>("promotions_calendar.csv"),
    loadCSV<Festival>("festive_calendar.csv")
  );
  res.json(analysis);
});

async function startServer() {
  const isProd = process.env.NODE_ENV === "production" || !!process.env.VERCEL;

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT} in ${isProd ? 'production' : 'development'} mode`);
  });
}

if (!process.env.VERCEL) {
  startServer();
}

export default app;
