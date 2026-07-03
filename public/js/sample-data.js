/* =================================================================
   MERVEKS SAP — per-industry sample packs
   Small, coherent starter datasets loaded only when a new business
   ticks "load sample data" at sign-up. Logistics is NOT here — it
   reuses the rich MERVEKS seed in seed.js. These packs are keyed by the
   same localStorage collection keys the Store uses, and deliberately
   omit users so the signed-up owner stays the only account.
   ================================================================= */
window.SAMPLE_PACKS = function (industry) {
  const today = new Date();
  const d = (off) => { const x = new Date(today); x.setDate(x.getDate() + off); return x.toISOString().slice(0, 10); };

  const PACKS = {
    /* ---------------- E-COMMERCE ---------------- */
    ecommerce: {
      sap_clients: [
        { id: "C-1001", name: "Aylin Kaya", country: "TR", sector: "Retail customer", contact: "Aylin Kaya", email: "aylin.kaya@gmail.com", phone: "+90 532 110 2200", status: "Active", since: d(-120), rating: 5, terms: 0 },
        { id: "C-1002", name: "James Porter", country: "GB", sector: "Retail customer", contact: "James Porter", email: "j.porter@outlook.com", phone: "+44 7700 900123", status: "Active", since: d(-80), rating: 4, terms: 0 },
        { id: "C-1003", name: "Sara Nilsson", country: "SE", sector: "Retail customer", contact: "Sara Nilsson", email: "sara.n@telia.se", phone: "+46 70 123 4567", status: "Active", since: d(-40), rating: 5, terms: 0 },
        { id: "C-1004", name: "BulkBuy Co.", country: "TR", sector: "Wholesale buyer", contact: "Mert Aydın", email: "mert@bulkbuy.com.tr", phone: "+90 212 555 7788", status: "Active", since: d(-200), rating: 4, terms: 14 }
      ],
      sap_suppliers: [
        { id: "S-2001", name: "Shenzhen Gadget Works", country: "CN", category: "Electronics", contact: "Li Wei", email: "li.wei@sgw.cn", phone: "+86 755 8800 1100", rating: 4 },
        { id: "S-2002", name: "İstanbul Textile Hub", country: "TR", category: "Apparel", contact: "Deniz Yılmaz", email: "deniz@isttextile.com", phone: "+90 212 444 3322", rating: 5 }
      ],
      sap_products: [
        { id: "P-3001", sku: "EW-PHN-CASE", name: "Phone Case — Clear", category: "Accessories", unit: "pcs", stock: 540, reorder: 100, price: 14.9, cost: 4.2, currency: "USD", warehouse: "Main Fulfilment", status: "In stock" },
        { id: "P-3002", sku: "EW-EARBUDS", name: "Wireless Earbuds Pro", category: "Electronics", unit: "pcs", stock: 38, reorder: 50, price: 59.0, cost: 28.0, currency: "USD", warehouse: "Main Fulfilment", status: "Low" },
        { id: "P-3003", sku: "EW-TEE-BLK", name: "Cotton T-Shirt — Black", category: "Apparel", unit: "pcs", stock: 0, reorder: 60, price: 22.0, cost: 8.5, currency: "USD", warehouse: "Main Fulfilment", status: "Out of stock" },
        { id: "P-3004", sku: "EW-BOTTLE", name: "Insulated Water Bottle 750ml", category: "Home", unit: "pcs", stock: 210, reorder: 80, price: 27.5, cost: 11.0, currency: "USD", warehouse: "Main Fulfilment", status: "In stock" }
      ],
      sap_orders: [
        { id: "O-5001", ref: "WEB-10231", client: "C-1001", date: d(-2), status: "Shipped", currency: "USD", freight: 5, shipmentId: "SH-7001", invoiceId: "I-9001", items: [{ product: "P-3001", qty: 2, price: 14.9 }, { product: "P-3004", qty: 1, price: 27.5 }] },
        { id: "O-5002", ref: "WEB-10232", client: "C-1002", date: d(-1), status: "Confirmed", currency: "USD", freight: 8, shipmentId: null, invoiceId: null, items: [{ product: "P-3002", qty: 1, price: 59.0 }] },
        { id: "O-5003", ref: "WEB-10233", client: "C-1004", date: d(0), status: "Pending", currency: "USD", freight: 0, shipmentId: null, invoiceId: null, items: [{ product: "P-3001", qty: 50, price: 12.0 }, { product: "P-3004", qty: 30, price: 22.0 }] }
      ],
      sap_shipments: [
        { id: "SH-7001", ref: "DLV-10231", client: "C-1001", orderId: "O-5001", mode: "Courier", origin: "Main Fulfilment", destination: "İzmir, TR", containers: 1, weightTons: 0, status: "In Transit", departed: d(-1), eta: d(1), docs: ["Shipping Label"], costs: { freight: 5, customs: 0, insurance: 0 }, tracking: [] }
      ],
      sap_invoices: [
        { id: "I-9001", no: "INV-10231", client: "C-1001", order: "O-5001", issued: d(-2), due: d(-2), amount: 62.3, paid: 62.3, currency: "USD", status: "Paid", vatRate: 0, vatAmount: 0, totalAmount: 62.3 }
      ],
      sap_purchaseorders: [
        { id: "PO-6001", ref: "PUR-10051", supplier: "S-2001", date: d(-10), currency: "USD", status: "Received", billId: "B-8001", warehouse: "Main Fulfilment", items: [{ product: "P-3002", name: "Wireless Earbuds Pro", qty: 100, price: 28.0 }] },
        { id: "PO-6002", ref: "PUR-10052", supplier: "S-2002", date: d(-3), currency: "USD", status: "Sent", billId: null, warehouse: "Main Fulfilment", items: [{ product: "P-3003", name: "Cotton T-Shirt — Black", qty: 120, price: 8.5 }] }
      ],
      sap_bills: [
        { id: "B-8001", no: "BILL-10051", supplier: "S-2001", po: "PO-6001", issued: d(-10), due: d(20), amount: 2800, paid: 2800, currency: "USD", status: "Paid" }
      ],
      sap_payments: [
        { id: "PM-9001", ref: "PAY-10031", kind: "in", party: "Aylin Kaya", doc: "I-9001", date: d(-2), amount: 62.3, currency: "USD", method: "Card" },
        { id: "PM-9002", ref: "PAY-10032", kind: "out", party: "Shenzhen Gadget Works", doc: "B-8001", date: d(-9), amount: 2800, currency: "USD", method: "Bank transfer" }
      ]
    },

    /* ---------------- WHOLESALE / DISTRIBUTION ---------------- */
    wholesale: {
      sap_clients: [
        { id: "C-1001", name: "Marmara Marketler A.Ş.", country: "TR", sector: "Supermarket chain", contact: "Hakan Demir", email: "hakan@marmaramarket.com", phone: "+90 216 333 1100", status: "Active", since: d(-300), rating: 5, terms: 30 },
        { id: "C-1002", name: "Balkan Foods Import", country: "BG", sector: "Importer", contact: "Petar Ivanov", email: "petar@balkanfoods.bg", phone: "+359 2 980 1122", status: "Active", since: d(-180), rating: 4, terms: 45 },
        { id: "C-1003", name: "Anadolu Bakkal Co-op", country: "TR", sector: "Grocery co-op", contact: "Elif Şahin", email: "elif@anadolubakkal.com", phone: "+90 312 222 4455", status: "Active", since: d(-90), rating: 4, terms: 30 }
      ],
      sap_suppliers: [
        { id: "S-2001", name: "Konya Grain Union", country: "TR", category: "Grain & flour", contact: "Ahmet Yıldız", email: "ahmet@konyagrain.com", phone: "+90 332 555 8899", rating: 5 },
        { id: "S-2002", name: "Aegean Olive Press", country: "TR", category: "Oils", contact: "Selin Acar", email: "selin@aegeanolive.com", phone: "+90 232 444 1212", rating: 5 }
      ],
      sap_products: [
        { id: "P-3001", sku: "WH-FLR-25", name: "Wheat Flour T55 — 25kg sack", category: "Grain", unit: "sack", stock: 1200, reorder: 300, price: 16.0, cost: 11.5, currency: "USD", warehouse: "Central DC", status: "In stock" },
        { id: "P-3002", sku: "WH-OIL-5L", name: "Sunflower Oil 5L — case of 4", category: "Oils", unit: "case", stock: 84, reorder: 120, price: 42.0, cost: 33.0, currency: "USD", warehouse: "Central DC", status: "Low" },
        { id: "P-3003", sku: "WH-SUGR-50", name: "Refined Sugar — 50kg sack", category: "Pantry", unit: "sack", stock: 640, reorder: 200, price: 38.0, cost: 30.0, currency: "USD", warehouse: "Central DC", status: "In stock" }
      ],
      sap_orders: [
        { id: "O-5001", ref: "SO-3301", client: "C-1001", date: d(-4), status: "Confirmed", currency: "USD", freight: 320, shipmentId: null, invoiceId: "I-9001", items: [{ product: "P-3001", qty: 200, price: 16.0 }, { product: "P-3003", qty: 80, price: 38.0 }] },
        { id: "O-5002", ref: "SO-3302", client: "C-1002", date: d(-2), status: "Pending", currency: "USD", freight: 0, shipmentId: null, invoiceId: null, items: [{ product: "P-3002", qty: 60, price: 42.0 }] }
      ],
      sap_shipments: [
        { id: "SH-7001", ref: "DLV-3301", client: "C-1001", orderId: "O-5001", mode: "Road", origin: "Central DC", destination: "İstanbul, TR", containers: 2, weightTons: 12, status: "Booked", departed: d(1), eta: d(2), docs: ["Delivery Note"], costs: { freight: 320, customs: 0, insurance: 40 }, tracking: [] }
      ],
      sap_invoices: [
        { id: "I-9001", no: "INV-3301", client: "C-1001", order: "O-5001", issued: d(-4), due: d(26), amount: 6240, paid: 0, currency: "USD", status: "Sent", vatRate: 0, vatAmount: 0, totalAmount: 6240 }
      ],
      sap_quotes: [
        { id: "Q-4001", ref: "QT-3301", client: "C-1001", date: d(-6), validUntil: d(8), currency: "USD", freight: 320, status: "Accepted", orderId: "O-5001", items: [{ product: "P-3001", qty: 200, price: 16.0 }, { product: "P-3003", qty: 80, price: 38.0 }], notes: "Bulk supermarket replenishment." },
        { id: "Q-4002", ref: "QT-3302", client: "C-1002", date: d(-2), validUntil: d(12), currency: "USD", freight: 0, status: "Sent", orderId: null, items: [{ product: "P-3002", qty: 60, price: 42.0 }], notes: "Export enquiry — awaiting confirmation." },
        { id: "Q-4003", ref: "QT-3303", client: "C-1003", date: d(-1), validUntil: d(14), currency: "USD", freight: 180, status: "Draft", orderId: null, items: [{ product: "P-3001", qty: 120, price: 16.5 }], notes: "" }
      ],
      sap_purchaseorders: [
        { id: "PO-6001", ref: "PUR-3301", supplier: "S-2001", date: d(-12), currency: "USD", status: "Received", billId: "B-8001", warehouse: "Central DC", items: [{ product: "P-3001", name: "Wheat Flour T55 — 25kg sack", qty: 800, price: 11.5 }] },
        { id: "PO-6002", ref: "PUR-3302", supplier: "S-2002", date: d(-2), currency: "USD", status: "Sent", billId: null, warehouse: "Central DC", items: [{ product: "P-3002", name: "Sunflower Oil 5L — case of 4", qty: 120, price: 33.0 }] }
      ],
      sap_bills: [
        { id: "B-8001", no: "BILL-3301", supplier: "S-2001", po: "PO-6001", issued: d(-12), due: d(18), amount: 9200, paid: 9200, currency: "USD", status: "Paid" }
      ],
      sap_payments: [
        { id: "PM-9001", ref: "PAY-3301", kind: "out", party: "Konya Grain Union", doc: "B-8001", date: d(-11), amount: 9200, currency: "USD", method: "Bank transfer" }
      ]
    },

    /* ---------------- RETAIL ---------------- */
    retail: {
      sap_clients: [
        { id: "C-1001", name: "Walk-in Customer", country: "TR", sector: "Counter sale", contact: "—", email: "", phone: "", status: "Active", since: d(-365), rating: 5, terms: 0 },
        { id: "C-1002", name: "Zeynep Arslan", country: "TR", sector: "Loyalty member", contact: "Zeynep Arslan", email: "zeynep.a@gmail.com", phone: "+90 533 220 1100", status: "Active", since: d(-60), rating: 5, terms: 0 }
      ],
      sap_suppliers: [
        { id: "S-2001", name: "Local Beverages Ltd.", country: "TR", category: "Drinks", contact: "Caner Öz", email: "caner@localbev.com", phone: "+90 216 700 1100", rating: 4 },
        { id: "S-2002", name: "Fresh Snacks Co.", country: "TR", category: "Snacks", contact: "Buse Kaya", email: "buse@freshsnacks.com", phone: "+90 212 800 2200", rating: 5 }
      ],
      sap_products: [
        { id: "P-3001", sku: "RT-COLA-33", name: "Cola 330ml can", category: "Drinks", unit: "pcs", stock: 480, reorder: 144, price: 1.2, cost: 0.6, currency: "USD", warehouse: "Store Floor", status: "In stock" },
        { id: "P-3002", sku: "RT-CHIPS-150", name: "Potato Chips 150g", category: "Snacks", unit: "pcs", stock: 60, reorder: 96, price: 2.1, cost: 1.0, currency: "USD", warehouse: "Store Floor", status: "Low" },
        { id: "P-3003", sku: "RT-WATER-50", name: "Spring Water 500ml", category: "Drinks", unit: "pcs", stock: 0, reorder: 200, price: 0.7, cost: 0.3, currency: "USD", warehouse: "Back Store", status: "Out of stock" },
        { id: "P-3004", sku: "RT-CHOC-80", name: "Milk Chocolate Bar 80g", category: "Confectionery", unit: "pcs", stock: 320, reorder: 100, price: 1.8, cost: 0.9, currency: "USD", warehouse: "Store Floor", status: "In stock" }
      ],
      sap_orders: [
        { id: "O-5001", ref: "POS-8801", client: "C-1001", date: d(0), status: "Completed", currency: "USD", freight: 0, shipmentId: null, invoiceId: "I-9001", items: [{ product: "P-3001", qty: 2, price: 1.2 }, { product: "P-3004", qty: 1, price: 1.8 }] },
        { id: "O-5002", ref: "POS-8802", client: "C-1002", date: d(0), status: "Completed", currency: "USD", freight: 0, shipmentId: null, invoiceId: "I-9002", items: [{ product: "P-3002", qty: 3, price: 2.1 }] }
      ],
      sap_invoices: [
        { id: "I-9001", no: "RCPT-8801", client: "C-1001", order: "O-5001", issued: d(0), due: d(0), amount: 4.2, paid: 4.2, currency: "USD", status: "Paid", vatRate: 0, vatAmount: 0, totalAmount: 4.2 },
        { id: "I-9002", no: "RCPT-8802", client: "C-1002", order: "O-5002", issued: d(0), due: d(0), amount: 6.3, paid: 6.3, currency: "USD", status: "Paid", vatRate: 0, vatAmount: 0, totalAmount: 6.3 }
      ],
      sap_purchaseorders: [
        { id: "PO-6001", ref: "PUR-8801", supplier: "S-2001", date: d(-7), currency: "USD", status: "Received", billId: "B-8001", warehouse: "Back Store", items: [{ product: "P-3001", name: "Cola 330ml can", qty: 480, price: 0.6 }] },
        { id: "PO-6002", ref: "PUR-8802", supplier: "S-2002", date: d(-1), currency: "USD", status: "Sent", billId: null, warehouse: "Back Store", items: [{ product: "P-3002", name: "Potato Chips 150g", qty: 200, price: 1.0 }] }
      ],
      sap_bills: [
        { id: "B-8001", no: "BILL-8801", supplier: "S-2001", po: "PO-6001", issued: d(-7), due: d(8), amount: 288, paid: 288, currency: "USD", status: "Paid" }
      ],
      sap_payments: [
        { id: "PM-9001", ref: "PAY-8801", kind: "in", party: "Walk-in Customer", doc: "I-9001", date: d(0), amount: 4.2, currency: "USD", method: "Cash" },
        { id: "PM-9002", ref: "PAY-8802", kind: "in", party: "Zeynep Arslan", doc: "I-9002", date: d(0), amount: 6.3, currency: "USD", method: "Card" },
        { id: "PM-9003", ref: "PAY-8803", kind: "out", party: "Local Beverages Ltd.", doc: "B-8001", date: d(-6), amount: 288, currency: "USD", method: "Bank transfer" }
      ]
    },

    /* ---------------- MANUFACTURING ---------------- */
    manufacturing: {
      sap_clients: [
        { id: "C-1001", name: "Anadolu Otomotiv A.Ş.", country: "TR", sector: "Automotive OEM", contact: "Kemal Doğan", email: "kemal@anadoluoto.com", phone: "+90 224 555 1100", status: "Active", since: d(-400), rating: 5, terms: 45 },
        { id: "C-1002", name: "Gulf Appliances Ltd.", country: "AE", sector: "White goods", contact: "Omar Rashid", email: "omar@gulfapp.ae", phone: "+971 4 880 2200", status: "Active", since: d(-220), rating: 4, terms: 30 },
        { id: "C-1003", name: "BalkanBuild Materials", country: "BG", sector: "Construction supply", contact: "Nikola Petrov", email: "nikola@balkanbuild.bg", phone: "+359 2 970 3300", status: "Active", since: d(-120), rating: 4, terms: 30 }
      ],
      sap_suppliers: [
        { id: "S-2001", name: "Ereğli Iron & Steel", country: "TR", category: "Steel & metal", contact: "Hasan Yıldırım", email: "hasan@erdemir.com", phone: "+90 372 333 4400", rating: 5 },
        { id: "S-2002", name: "Petkim Polymers", country: "TR", category: "Plastics & resin", contact: "Aylin Kurt", email: "aylin@petkim.com", phone: "+90 232 616 1212", rating: 4 },
        { id: "S-2003", name: "Bosch Components", country: "DE", category: "Electronics", contact: "Markus Weber", email: "m.weber@bosch.de", phone: "+49 711 400 5500", rating: 5 }
      ],
      sap_products: [
        { id: "P-3001", sku: "RM-STEEL-CR", name: "Cold-Rolled Steel Coil (1t)", category: "Raw material", unit: "t", stock: 240, reorder: 60, price: 720, cost: 720, currency: "USD", warehouse: "Raw Material Store", status: "In stock" },
        { id: "P-3002", sku: "RM-POLY-HD", name: "HDPE Resin Granulate (25kg)", category: "Raw material", unit: "sack", stock: 38, reorder: 80, price: 41, cost: 41, currency: "USD", warehouse: "Raw Material Store", status: "Low" },
        { id: "P-3003", sku: "FG-BRKT-A1", name: "Steel Mounting Bracket A1", category: "Finished goods", unit: "pcs", stock: 4200, reorder: 1000, price: 3.4, cost: 1.6, currency: "USD", warehouse: "Finished Goods", status: "In stock" },
        { id: "P-3004", sku: "FG-HOUS-P2", name: "Polymer Housing P2", category: "Finished goods", unit: "pcs", stock: 760, reorder: 800, price: 5.8, cost: 2.7, currency: "USD", warehouse: "Finished Goods", status: "Low" }
      ],
      sap_quotes: [
        { id: "Q-4001", ref: "QT-MF-7701", client: "C-1001", date: d(-10), validUntil: d(10), currency: "USD", freight: 1200, status: "Accepted", orderId: "O-5001", items: [{ product: "P-3003", qty: 20000, price: 3.4 }], notes: "Annual bracket supply contract." },
        { id: "Q-4002", ref: "QT-MF-7702", client: "C-1002", date: d(-3), validUntil: d(12), currency: "USD", freight: 800, status: "Sent", orderId: null, items: [{ product: "P-3004", qty: 5000, price: 5.8 }], notes: "Awaiting buyer sign-off." }
      ],
      sap_orders: [
        { id: "O-5001", ref: "WO-7701", client: "C-1001", date: d(-8), status: "Shipped", currency: "USD", freight: 1200, quoteId: "Q-4001", shipmentId: "SH-7001", invoiceId: "I-9001", items: [{ product: "P-3003", qty: 20000, price: 3.4 }] },
        { id: "O-5002", ref: "WO-7702", client: "C-1003", date: d(-2), status: "Confirmed", currency: "USD", freight: 0, quoteId: null, shipmentId: null, invoiceId: null, items: [{ product: "P-3003", qty: 8000, price: 3.5 }] }
      ],
      sap_shipments: [
        { id: "SH-7001", ref: "DSP-7701", client: "C-1001", orderId: "O-5001", mode: "Road", origin: "Plant 1", destination: "Bursa, TR", containers: 3, weightTons: 18, status: "Delivered", departed: d(-6), eta: d(-4), docs: ["Delivery Note", "Quality Cert"], costs: { freight: 1200, customs: 0, insurance: 150 }, tracking: [] }
      ],
      sap_invoices: [
        { id: "I-9001", no: "INV-MF-7701", client: "C-1001", order: "O-5001", issued: d(-6), due: d(39), amount: 68000, paid: 30000, currency: "USD", status: "Partial", vatRate: 20, vatAmount: 13600, totalAmount: 81600 }
      ],
      sap_purchaseorders: [
        { id: "PO-6001", ref: "MAT-7701", supplier: "S-2001", date: d(-14), currency: "USD", status: "Received", billId: "B-8001", warehouse: "Raw Material Store", items: [{ product: "P-3001", name: "Cold-Rolled Steel Coil (1t)", qty: 120, price: 720 }] },
        { id: "PO-6002", ref: "MAT-7702", supplier: "S-2002", date: d(-3), currency: "USD", status: "Sent", billId: null, warehouse: "Raw Material Store", items: [{ product: "P-3002", name: "HDPE Resin Granulate (25kg)", qty: 200, price: 41 }] }
      ],
      sap_bills: [
        { id: "B-8001", no: "BILL-MF-7701", supplier: "S-2001", po: "PO-6001", issued: d(-14), due: d(16), amount: 86400, paid: 86400, currency: "USD", status: "Paid" }
      ],
      sap_payments: [
        { id: "PM-9001", ref: "PAY-MF-7701", kind: "in", party: "Anadolu Otomotiv A.Ş.", doc: "I-9001", date: d(-2), amount: 30000, currency: "USD", method: "Bank transfer" },
        { id: "PM-9002", ref: "PAY-MF-7702", kind: "out", party: "Ereğli Iron & Steel", doc: "B-8001", date: d(-13), amount: 86400, currency: "USD", method: "Bank transfer" }
      ]
    },

    /* ---------------- RESTAURANT / FOOD SERVICE ---------------- */
    restaurant: {
      sap_clients: [
        { id: "C-1001", name: "Walk-in Guest", country: "TR", sector: "Dine-in", contact: "—", email: "", phone: "", status: "Active", since: d(-365), rating: 5, terms: 0 },
        { id: "C-1002", name: "TechPark Catering", country: "TR", sector: "Corporate catering", contact: "Deniz Aksoy", email: "deniz@techpark.com", phone: "+90 216 444 7788", status: "Active", since: d(-90), rating: 5, terms: 14 },
        { id: "C-1003", name: "Online Delivery (Getir)", country: "TR", sector: "Delivery platform", contact: "Platform Orders", email: "merchant@getir.com", phone: "+90 850 222 0000", status: "Active", since: d(-200), rating: 4, terms: 7 }
      ],
      sap_suppliers: [
        { id: "S-2001", name: "Antalya Fresh Produce", country: "TR", category: "Produce", contact: "Mehmet Çiftçi", email: "mehmet@antalyafresh.com", phone: "+90 242 333 1100", rating: 5 },
        { id: "S-2002", name: "Marmara Meat & Poultry", country: "TR", category: "Meat", contact: "Ali Kaya", email: "ali@marmarameat.com", phone: "+90 212 555 6677", rating: 4 },
        { id: "S-2003", name: "Efes Beverages", country: "TR", category: "Beverages", contact: "Sinem Yıldız", email: "sinem@efesbev.com", phone: "+90 232 700 8899", rating: 5 }
      ],
      sap_products: [
        { id: "P-3001", sku: "MN-BURGER", name: "Signature Beef Burger", category: "Mains", unit: "plate", stock: 0, reorder: 0, price: 12.5, cost: 4.2, currency: "USD", warehouse: "Main Kitchen", status: "In stock" },
        { id: "P-3002", sku: "MN-PIZZA", name: "Margherita Pizza", category: "Mains", unit: "plate", stock: 0, reorder: 0, price: 10.0, cost: 3.0, currency: "USD", warehouse: "Main Kitchen", status: "In stock" },
        { id: "P-3003", sku: "IN-BEEF-PT", name: "Beef Patty (frozen, box of 48)", category: "Ingredient", unit: "box", stock: 6, reorder: 10, price: 38, cost: 38, currency: "USD", warehouse: "Cold Store", status: "Low" },
        { id: "P-3004", sku: "BV-COLA-DR", name: "Cola (draught, 20L keg)", category: "Beverage", unit: "keg", stock: 4, reorder: 6, price: 45, cost: 45, currency: "USD", warehouse: "Bar", status: "Low" },
        { id: "P-3005", sku: "DS-CHEESE", name: "Cheesecake Slice", category: "Dessert", unit: "plate", stock: 0, reorder: 0, price: 6.0, cost: 1.8, currency: "USD", warehouse: "Main Kitchen", status: "In stock" }
      ],
      sap_orders: [
        { id: "O-5001", ref: "TBL-12", client: "C-1001", date: d(0), status: "Completed", currency: "USD", freight: 0, shipmentId: null, invoiceId: "I-9001", items: [{ product: "P-3001", qty: 2, price: 12.5 }, { product: "P-3004", qty: 2, price: 4.0 }] },
        { id: "O-5002", ref: "CAT-204", client: "C-1002", date: d(-1), status: "Confirmed", currency: "USD", freight: 0, shipmentId: null, invoiceId: "I-9002", items: [{ product: "P-3002", qty: 30, price: 10.0 }, { product: "P-3005", qty: 30, price: 6.0 }] },
        { id: "O-5003", ref: "DLV-8841", client: "C-1003", date: d(0), status: "Completed", currency: "USD", freight: 0, shipmentId: null, invoiceId: "I-9003", items: [{ product: "P-3001", qty: 1, price: 12.5 }, { product: "P-3005", qty: 1, price: 6.0 }] }
      ],
      sap_invoices: [
        { id: "I-9001", no: "RCPT-12", client: "C-1001", order: "O-5001", issued: d(0), due: d(0), amount: 33.0, paid: 33.0, currency: "USD", status: "Paid", vatRate: 8, vatAmount: 2.64, totalAmount: 35.64 },
        { id: "I-9002", no: "INV-CAT-204", client: "C-1002", order: "O-5002", issued: d(-1), due: d(13), amount: 480, paid: 0, currency: "USD", status: "Sent", vatRate: 8, vatAmount: 38.4, totalAmount: 518.4 },
        { id: "I-9003", no: "RCPT-8841", client: "C-1003", order: "O-5003", issued: d(0), due: d(0), amount: 18.5, paid: 18.5, currency: "USD", status: "Paid", vatRate: 8, vatAmount: 1.48, totalAmount: 19.98 }
      ],
      sap_purchaseorders: [
        { id: "PO-6001", ref: "SUP-7701", supplier: "S-2002", date: d(-4), currency: "USD", status: "Received", billId: "B-8001", warehouse: "Cold Store", items: [{ product: "P-3003", name: "Beef Patty (frozen, box of 48)", qty: 20, price: 38 }] },
        { id: "PO-6002", ref: "SUP-7702", supplier: "S-2003", date: d(-1), currency: "USD", status: "Sent", billId: null, warehouse: "Bar", items: [{ product: "P-3004", name: "Cola (draught, 20L keg)", qty: 12, price: 45 }] }
      ],
      sap_bills: [
        { id: "B-8001", no: "BILL-7701", supplier: "S-2002", po: "PO-6001", issued: d(-4), due: d(10), amount: 760, paid: 760, currency: "USD", status: "Paid" }
      ],
      sap_payments: [
        { id: "PM-9001", ref: "PAY-7701", kind: "in", party: "Walk-in Guest", doc: "I-9001", date: d(0), amount: 35.64, currency: "USD", method: "Card" },
        { id: "PM-9002", ref: "PAY-7702", kind: "in", party: "Online Delivery (Getir)", doc: "I-9003", date: d(0), amount: 19.98, currency: "USD", method: "Platform" },
        { id: "PM-9003", ref: "PAY-7703", kind: "out", party: "Marmara Meat & Poultry", doc: "B-8001", date: d(-3), amount: 760, currency: "USD", method: "Bank transfer" }
      ]
    },

    /* ---------------- CONSTRUCTION ---------------- */
    construction: {
      sap_clients: [
        { id: "C-1001", name: "Emaar Development TR", country: "TR", sector: "Property developer", contact: "Burak Şen", email: "burak@emaar.com.tr", phone: "+90 212 999 1100", status: "Active", since: d(-500), rating: 5, terms: 45 },
        { id: "C-1002", name: "İstanbul Metro Authority", country: "TR", sector: "Public infrastructure", contact: "Eng. Tuncay Er", email: "tuncay@metro.istanbul", phone: "+90 212 568 9900", status: "Active", since: d(-300), rating: 5, terms: 60 },
        { id: "C-1003", name: "Coastal Resorts Group", country: "TR", sector: "Hospitality", contact: "Leyla Demir", email: "leyla@coastalresorts.com", phone: "+90 242 444 2233", status: "Active", since: d(-150), rating: 4, terms: 45 }
      ],
      sap_suppliers: [
        { id: "S-2001", name: "Akçansa Cement", country: "TR", category: "Cement & aggregate", contact: "Osman Tekin", email: "osman@akcansa.com.tr", phone: "+90 216 571 3000", rating: 5 },
        { id: "S-2002", name: "İçdaş Rebar & Steel", country: "TR", category: "Reinforcement steel", contact: "Hülya Arı", email: "hulya@icdas.com.tr", phone: "+90 212 880 4400", rating: 4 },
        { id: "S-2003", name: "Borusan Heavy Equipment", country: "TR", category: "Equipment rental", contact: "Cem Yalçın", email: "cem@borusan.com", phone: "+90 216 500 6600", rating: 5 }
      ],
      sap_products: [
        { id: "P-3001", sku: "MT-CEM-42", name: "Portland Cement CEM I 42.5 (1t)", category: "Material", unit: "t", stock: 180, reorder: 50, price: 95, cost: 95, currency: "USD", warehouse: "Central Yard", status: "In stock" },
        { id: "P-3002", sku: "MT-REBAR-16", name: "Rebar Ø16mm (1t bundle)", category: "Material", unit: "t", stock: 22, reorder: 40, price: 640, cost: 640, currency: "USD", warehouse: "Central Yard", status: "Low" },
        { id: "P-3003", sku: "EQ-EXCAV", name: "Excavator (daily hire)", category: "Equipment", unit: "day", stock: 3, reorder: 1, price: 480, cost: 320, currency: "USD", warehouse: "Central Yard", status: "In stock" }
      ],
      sap_quotes: [
        { id: "Q-4001", ref: "TND-9901", client: "C-1001", date: d(-20), validUntil: d(10), currency: "USD", freight: 0, status: "Accepted", orderId: "O-5001", items: [{ product: "P-3001", qty: 1200, price: 95 }, { product: "P-3002", qty: 300, price: 640 }], notes: "Phase-1 superstructure tender." },
        { id: "Q-4002", ref: "TND-9902", client: "C-1003", date: d(-5), validUntil: d(20), currency: "USD", freight: 0, status: "Sent", orderId: null, items: [{ product: "P-3001", qty: 400, price: 96 }], notes: "Resort villas — estimate pending." }
      ],
      sap_orders: [
        { id: "O-5001", ref: "PRJ-9901", client: "C-1001", date: d(-18), status: "Shipped", currency: "USD", freight: 4200, quoteId: "Q-4001", shipmentId: "SH-7001", invoiceId: "I-9001", items: [{ product: "P-3001", qty: 1200, price: 95 }, { product: "P-3002", qty: 300, price: 640 }] },
        { id: "O-5002", ref: "PRJ-9902", client: "C-1002", date: d(-6), status: "Confirmed", currency: "USD", freight: 0, quoteId: null, shipmentId: null, invoiceId: null, items: [{ product: "P-3003", qty: 30, price: 480 }] }
      ],
      sap_shipments: [
        { id: "SH-7001", ref: "SITE-9901", client: "C-1001", orderId: "O-5001", mode: "Heavy Haul", origin: "Central Yard", destination: "Maslak Site, İstanbul", containers: 8, weightTons: 26, status: "Delivered", departed: d(-15), eta: d(-12), docs: ["Delivery Note", "Weighbridge Ticket"], costs: { freight: 4200, customs: 0, insurance: 300 }, tracking: [] }
      ],
      sap_invoices: [
        { id: "I-9001", no: "INV-9901", client: "C-1001", order: "O-5001", issued: d(-15), due: d(30), amount: 306000, paid: 150000, currency: "USD", status: "Partial", vatRate: 20, vatAmount: 61200, totalAmount: 367200 }
      ],
      sap_purchaseorders: [
        { id: "PO-6001", ref: "MAT-9901", supplier: "S-2002", date: d(-16), currency: "USD", status: "Received", billId: "B-8001", warehouse: "Central Yard", items: [{ product: "P-3002", name: "Rebar Ø16mm (1t bundle)", qty: 300, price: 600 }] },
        { id: "PO-6002", ref: "MAT-9902", supplier: "S-2003", date: d(-4), currency: "USD", status: "Sent", billId: null, warehouse: "Site Store", items: [{ product: "P-3003", name: "Excavator (daily hire)", qty: 30, price: 320 }] }
      ],
      sap_bills: [
        { id: "B-8001", no: "BILL-9901", supplier: "S-2002", po: "PO-6001", issued: d(-16), due: d(14), amount: 180000, paid: 180000, currency: "USD", status: "Paid" }
      ],
      sap_payments: [
        { id: "PM-9001", ref: "PAY-9901", kind: "in", party: "Emaar Development TR", doc: "I-9001", date: d(-3), amount: 150000, currency: "USD", method: "Bank transfer" },
        { id: "PM-9002", ref: "PAY-9902", kind: "out", party: "İçdaş Rebar & Steel", doc: "B-8001", date: d(-15), amount: 180000, currency: "USD", method: "Bank transfer" }
      ]
    },

    /* ---------------- SERVICES / CONSULTING ---------------- */
    services: {
      sap_clients: [
        { id: "C-1001", name: "Vodafone Türkiye", country: "TR", sector: "Telecom", contact: "Selin Öztürk", email: "selin@vodafone.com.tr", phone: "+90 212 939 1100", status: "Active", since: d(-280), rating: 5, terms: 30 },
        { id: "C-1002", name: "Akbank Digital", country: "TR", sector: "Banking", contact: "Mert Aydın", email: "mert@akbank.com", phone: "+90 212 385 5555", status: "Active", since: d(-160), rating: 5, terms: 45 },
        { id: "C-1003", name: "GreenStart GmbH", country: "DE", sector: "Cleantech startup", contact: "Anna Schmidt", email: "anna@greenstart.de", phone: "+49 30 700 8800", status: "Active", since: d(-60), rating: 4, terms: 30 },
        { id: "C-1004", name: "Retail Co. MENA", country: "AE", sector: "Retail group", contact: "Yousef Karim", email: "yousef@retailco.ae", phone: "+971 4 555 9090", status: "Active", since: d(-40), rating: 4, terms: 30 }
      ],
      sap_quotes: [
        { id: "Q-4001", ref: "PRP-5501", client: "C-1001", date: d(-14), validUntil: d(16), currency: "USD", freight: 0, status: "Accepted", orderId: "O-5001", items: [{ product: null, qty: 1, price: 48000 }], notes: "CRM migration — 12-week engagement." },
        { id: "Q-4002", ref: "PRP-5502", client: "C-1003", date: d(-4), validUntil: d(26), currency: "USD", freight: 0, status: "Sent", orderId: null, items: [{ product: null, qty: 1, price: 16000 }], notes: "Go-to-market advisory proposal." },
        { id: "Q-4003", ref: "PRP-5503", client: "C-1004", date: d(-1), validUntil: d(29), currency: "USD", freight: 0, status: "Draft", orderId: null, items: [{ product: null, qty: 1, price: 22000 }], notes: "" }
      ],
      sap_orders: [
        { id: "O-5001", ref: "ENG-5501", client: "C-1001", date: d(-12), status: "Shipped", currency: "USD", freight: 0, quoteId: "Q-4001", shipmentId: null, invoiceId: "I-9001", items: [{ product: null, qty: 1, price: 48000 }] },
        { id: "O-5002", ref: "ENG-5502", client: "C-1002", date: d(-30), status: "Completed", currency: "USD", freight: 0, quoteId: null, shipmentId: null, invoiceId: "I-9002", items: [{ product: null, qty: 1, price: 65000 }] }
      ],
      sap_invoices: [
        { id: "I-9001", no: "INV-5501", client: "C-1001", order: "O-5001", issued: d(-12), due: d(18), amount: 24000, paid: 0, currency: "USD", status: "Sent", vatRate: 20, vatAmount: 4800, totalAmount: 28800 },
        { id: "I-9003", no: "INV-5499", client: "C-1002", order: null, issued: d(-50), due: d(-20), amount: 32000, paid: 32000, currency: "USD", status: "Paid", vatRate: 20, vatAmount: 6400, totalAmount: 38400 },
        { id: "I-9002", no: "INV-5502", client: "C-1002", order: "O-5002", issued: d(-30), due: d(-2), amount: 65000, paid: 0, currency: "USD", status: "Overdue", vatRate: 20, vatAmount: 13000, totalAmount: 78000 }
      ],
      sap_payments: [
        { id: "PM-9001", ref: "PAY-5499", kind: "in", party: "Akbank Digital", doc: "I-9003", date: d(-22), amount: 38400, currency: "USD", method: "Bank transfer" }
      ]
    }
  };

  return PACKS[industry] || {};
};
