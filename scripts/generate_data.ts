import fs from 'fs';
import path from 'path';
import { format, addWeeks, subWeeks, startOfWeek, isSameWeek } from 'date-fns';

const DATA_DIR = path.join(process.cwd(), 'public', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const SKUS = Array.from({ length: 40 }, (_, i) => `SKU-${(i + 1).toString().padStart(3, '0')}`);
const OUTLETS = Array.from({ length: 320 }, (_, i) => `OUTLET-${(i + 1).toString().padStart(3, '0')}`);
const TOTAL_WEEKS = 156;
const END_DATE = new Date('2024-04-28'); // A recent Sunday

// 1. SKU Master
const skuMaster = SKUS.map(id => {
  const isPromoSKU = ['SKU-001', 'SKU-002', 'SKU-021', 'SKU-031'].includes(id);
  return {
    sku_id: id,
    sku_name: `Product ${id}`,
    moq: Math.floor(Math.random() * 50) + 10,
    shelf_life_days: Math.floor(Math.random() * 100) + 30,
    lead_time_days: Math.floor(Math.random() * 10) + 3,
    is_promo_sku: isPromoSKU
  };
});

fs.writeFileSync(path.join(DATA_DIR, 'sku_master.csv'), 
  'sku_id,sku_name,moq,shelf_life_days,lead_time_days\n' + 
  skuMaster.map(s => `${s.sku_id},${s.sku_name},${s.moq},${s.shelf_life_days},${s.lead_time_days}`).join('\n')
);

// 2. Festive Calendar
const festivals = [
  { date: '2022-10-24', name: 'Diwali 2022' },
  { date: '2023-10-16', name: 'Diwali 2023' },
  { date: '2022-12-25', name: 'Christmas 2022' },
  { date: '2023-12-25', name: 'Christmas 2023' }
];
fs.writeFileSync(path.join(DATA_DIR, 'festive_calendar.csv'),
  'week_date,festival_name\n' + 
  festivals.map(f => `${f.date},${f.name}`).join('\n')
);

// 3. Promotions Calendar
// SKU-001, SKU-002, SKU-021, SKU-031 get promos
const promos = [];
const promoSKUs = ['SKU-001', 'SKU-002', 'SKU-021', 'SKU-031'];
for (let i = 0; i < 20; i++) {
  const randomDate = format(subWeeks(END_DATE, Math.floor(Math.random() * 150)), 'yyyy-MM-dd');
  const sku = promoSKUs[Math.floor(Math.random() * promoSKUs.length)];
  promos.push({ sku_id: sku, week_date: randomDate, uplift: 0.85 + Math.random() * 0.05 });
}
fs.writeFileSync(path.join(DATA_DIR, 'promotions_calendar.csv'),
  'sku_id,week_date,promo_uplift_factor\n' +
  promos.map(p => `${p.sku_id},${p.week_date},${p.uplift}`).join('\n')
);

// 4. Sales History (Aggregated for efficiency in this script, but structure preserved)
const salesHistory: string[] = ['sku_id,outlet_id,week_date,units_sold'];
const startDate = subWeeks(END_DATE, TOTAL_WEEKS);

SKUS.forEach(sku => {
  const baseDemand = Math.random() * 20 + 5;
  const isSeasonal = Math.random() > 0.7;
  const isDead = Math.random() > 0.9;
  
  OUTLETS.slice(0, 10).forEach(outlet => { // Reducing outlets for sample size in script, but logic remains
    for (let w = 0; w < TOTAL_WEEKS; w++) {
      const currentDate = addWeeks(startDate, w);
      const dateStr = format(currentDate, 'yyyy-MM-dd');
      
      let demand = baseDemand + (Math.random() * 5);
      
      // Festival Spikes
      if (festivals.some(f => isSameWeek(new Date(f.date), currentDate))) {
        demand *= 2.5; 
        // Special case for Diwali 2023 stockout logic
        if (dateStr === '2023-10-16' && ['SKU-001', 'SKU-002'].includes(sku)) {
          demand = 0; // Simulate stockout drop
        }
      }

      // Promo uplift
      const promo = promos.find(p => p.sku_id === sku && p.week_date === dateStr);
      if (promo) demand *= (1 + promo.uplift);

      if (isDead) demand *= 0.1;

      // Random reporting gaps
      if (Math.random() > 0.95) demand = 0;

      salesHistory.push(`${sku},${outlet},${dateStr},${Math.round(demand)}`);
    }
  });
});

fs.writeFileSync(path.join(DATA_DIR, 'sales_history.csv'), salesHistory.join('\n'));

// 5. Inventory Snapshot
const inventory = SKUS.map(sku => {
  return {
    sku_id: sku,
    warehouse_stock: Math.floor(Math.random() * 500) + 50,
    in_transit_qty: Math.floor(Math.random() * 100),
    committed_qty: Math.floor(Math.random() * 50)
  };
});
fs.writeFileSync(path.join(DATA_DIR, 'inventory_snapshot.csv'),
  'sku_id,warehouse_stock,in_transit_qty,committed_qty\n' +
  inventory.map(i => `${i.sku_id},${i.warehouse_stock},${i.in_transit_qty},${i.committed_qty}`).join('\n')
);

console.log('Sample data generated in public/data/');
