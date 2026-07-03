/* =================================================================
   MERVEKS SAP — demo seed data
   Realistic, fully-linked operational records for a Mersin/Istanbul
   logistics & trading company. The records reference each other so the
   whole chain works in order:
     Quote → Order → Shipment + Invoice → Payment
     Purchase Order → Receive → Supplier Bill → Payment
   Used only in DEMO mode (no backend connected).
   ================================================================= */
window.SEED_DATA = function () {
  const today = new Date();
  const SEED_VER = "7"; // bump when the demo schema changes to force a re-seed
  const d = (offset) => { const x = new Date(today); x.setDate(x.getDate() + offset); return x.toISOString().slice(0, 10); };
  const ts = (daysAgo, h) => { const x = new Date(today); x.setDate(x.getDate() - daysAgo); x.setHours(h || 9, (h ? 12 : 30), 0, 0); return x.toISOString(); };

  return {
    sap_users: [
      { id: "U-001", name: "Mustafa Başarman", email: "owner@merveks.com", password: "merveks2013", role: "Owner", dept: "Management", active: true, joined: "2013-04-01", salary: 18000, currency: "USD", raiseLogs: [{ date: "2024-01-01", pct: 10, note: "Founder annual review" }] },
      { id: "U-002", name: "Selin Korkmaz",    email: "operations@merveks.com", password: "ops123",      role: "Operations Manager", dept: "Logistics",         active: true,  joined: "2016-09-12", salary: 8500,  currency: "USD", raiseLogs: [{ date: "2024-01-01", pct: 8, note: "Excellent shipment operations" }] },
      { id: "U-003", name: "Burak Demir",      email: "finance@merveks.com",    password: "fin123",      role: "Finance Officer",    dept: "Finance",           active: true,  joined: "2018-02-05", salary: 7200,  currency: "USD", raiseLogs: [{ date: "2024-01-01", pct: 5, note: "Standard annual review" }] },
      { id: "U-004", name: "Ayşe Yıldız",      email: "trade@merveks.com",      password: "trade123",    role: "Trade Specialist",   dept: "Distribution",      active: true,  joined: "2020-06-22", salary: 6000,  currency: "USD", raiseLogs: [] },
      { id: "U-005", name: "Emre Şahin",       email: "warehouse@merveks.com",  password: "wh123",       role: "Operations Manager", dept: "Mersin Warehouse",  active: false, joined: "2021-11-03", salary: 5500,  currency: "USD", raiseLogs: [] }
    ],

    sap_clients: [
      { id: "C-1001", name: "Gazprom Neft Trading", country: "RU", sector: "Energy", contact: "Igor Sokolov", email: "i.sokolov@gpn-trade.ru", phone: "+7 495 777 1200", status: "Active", since: "2014-03-01", rating: 5, terms: 30 },
      { id: "C-1002", name: "Nestlé MENA", country: "TR", sector: "Food & Beverage", contact: "Leyla Aydın", email: "leyla.aydin@nestle.com", phone: "+90 212 444 0900", status: "Active", since: "2016-06-12", rating: 5, terms: 30 },
      { id: "C-1003", name: "BASF Türk Kimya", country: "TR", sector: "Chemicals", contact: "Onur Çelik", email: "onur.celik@basf.com", phone: "+90 216 349 4000", status: "Active", since: "2017-09-04", rating: 4, terms: 45 },
      { id: "C-1004", name: "Azerbaijan Railways CJSC", country: "AZ", sector: "Transport", contact: "Rashad Mammadov", email: "r.mammadov@ady.az", phone: "+994 12 499 4500", status: "Active", since: "2015-01-20", rating: 5, terms: 30 },
      { id: "C-1005", name: "Limak Holding", country: "TR", sector: "Construction", contact: "Deniz Şahin", email: "d.sahin@limak.com.tr", phone: "+90 312 211 9000", status: "Active", since: "2018-11-08", rating: 4, terms: 30 },
      { id: "C-1006", name: "Tehran Industrial Group", country: "IR", sector: "Manufacturing", contact: "Hossein Karimi", email: "h.karimi@tig.ir", phone: "+98 21 8800 5500", status: "On hold", since: "2019-04-15", rating: 3, terms: 15 },
      { id: "C-1007", name: "Georgian Trade Partners", country: "GE", sector: "Wholesale", contact: "Nino Beridze", email: "nino@gtp.ge", phone: "+995 32 220 1100", status: "Active", since: "2020-07-22", rating: 4, terms: 30 },
      { id: "C-1008", name: "Mersin Free Zone Foods", country: "TR", sector: "Food & Beverage", contact: "Kerem Aslan", email: "kerem@mfzfoods.com", phone: "+90 324 238 1000", status: "Active", since: "2021-02-10", rating: 4, terms: 30 }
    ],

    sap_suppliers: [
      { id: "S-2001", name: "Nano Z Coating GmbH", country: "DE", category: "Nano Coating", contact: "Klaus Werner", email: "k.werner@nanoz.de", phone: "+49 30 5557 8800", rating: 5 },
      { id: "S-2002", name: "Çukurova Agro Co-op", country: "TR", category: "Food Supply", contact: "Fatma Öztürk", email: "fatma@cukurovaagro.com.tr", phone: "+90 322 458 7700", rating: 4 },
      { id: "S-2003", name: "TCDD Logistics", country: "TR", category: "Rail Capacity", contact: "Hakan Arı", email: "hakan.ari@tcddtasimacilik.gov.tr", phone: "+90 312 309 0500", rating: 5 },
      { id: "S-2004", name: "Siemens Machinery TR", country: "TR", category: "Industrial Equipment", contact: "Murat Kaya", email: "murat.kaya@siemens.com", phone: "+90 216 459 2000", rating: 5 },
      { id: "S-2005", name: "Antalya Citrus Union", country: "TR", category: "Food Supply", contact: "Elif Demirtaş", email: "elif@antalyacitrus.com", phone: "+90 242 311 4400", rating: 4 }
    ],

    sap_products: [
      { id: "P-3001", sku: "NZC-IND-20", name: "Nano-Z Industrial Coating 20L", category: "Nano-Z Coating", unit: "drum", stock: 184, reorder: 60, price: 420, cost: 300, currency: "USD", warehouse: "Mersin Main", status: "In stock" },
      { id: "P-3002", sku: "NZC-AUTO-5", name: "Nano-Z Automotive Sealant 5L", category: "Nano-Z Coating", unit: "can", stock: 42, reorder: 50, price: 165, cost: 110, currency: "USD", warehouse: "Mersin Main", status: "Low" },
      { id: "P-3003", sku: "NZC-MAR-25", name: "Nano-Z Marine Anti-Foul 25L", category: "Nano-Z Coating", unit: "drum", stock: 0, reorder: 30, price: 690, cost: 480, currency: "USD", warehouse: "Istanbul DC", status: "Out of stock" },
      { id: "P-3004", sku: "FS-CIT-1T", name: "Antalya Citrus — Class I (1t)", category: "Food Supply", unit: "tonne", stock: 96, reorder: 40, price: 980, cost: 800, currency: "EUR", warehouse: "Mersin Cold Store", status: "In stock", batch: "CIT-2406", expiry: d(40) },
      { id: "P-3005", sku: "FS-HZL-500", name: "Hazelnut Kernels 500kg", category: "Food Supply", unit: "pallet", stock: 58, reorder: 25, price: 3100, cost: 2450, currency: "EUR", warehouse: "Mersin Cold Store", status: "In stock", batch: "HZL-2405", expiry: d(120) },
      { id: "P-3006", sku: "FS-OIL-20", name: "Refined Sunflower Oil 20L", category: "Food Supply", unit: "case", stock: 310, reorder: 120, price: 38, cost: 30, currency: "USD", warehouse: "Mersin Main", status: "In stock", batch: "OIL-2406", expiry: d(220) },
      { id: "P-3007", sku: "FS-FLR-50", name: "Wheat Flour T55 50kg", category: "Food Supply", unit: "bag", stock: 71, reorder: 100, price: 22, cost: 16, currency: "USD", warehouse: "Istanbul DC", status: "Low", batch: "FLR-2406", expiry: d(95) },
      { id: "P-3008", sku: "NZC-CLR-1", name: "Nano-Z Clear Glass Coat 1L", category: "Nano-Z Coating", unit: "bottle", stock: 240, reorder: 80, price: 54, cost: 36, currency: "USD", warehouse: "Mersin Main", status: "In stock" }
    ],

    /* ---- 1. QUOTATIONS (start of the sales chain) ---- */
    sap_quotes: [
      { id: "Q-4001", ref: "QT-2024-0118", client: "C-1004", date: d(-12), validUntil: d(3), currency: "USD", freight: 6200, status: "Accepted", orderId: "O-5001", items: [{ product: "P-3001", qty: 80, price: 420 }, { product: "P-3008", qty: 120, price: 54 }], notes: "Rail freight Mersin → Baku, 12 containers." },
      { id: "Q-4002", ref: "QT-2024-0119", client: "C-1002", date: d(-9), validUntil: d(6), currency: "EUR", freight: 2400, status: "Accepted", orderId: "O-5002", items: [{ product: "P-3004", qty: 40, price: 980 }, { product: "P-3005", qty: 12, price: 3100 }], notes: "Reefer road transport." },
      { id: "Q-4003", assignedTo: "U-004", ref: "QT-2024-0123", client: "C-1007", date: d(-3), validUntil: d(11), currency: "USD", freight: 3100, status: "Sent", orderId: null, items: [{ product: "P-3006", qty: 150, price: 38 }], notes: "Awaiting client confirmation." },
      { id: "Q-4004", assignedTo: "U-004", ref: "QT-2024-0124", client: "C-1003", date: d(-1), validUntil: d(14), currency: "USD", freight: 1800, status: "Draft", orderId: null, items: [{ product: "P-3002", qty: 30, price: 165 }], notes: "" },
      { id: "Q-4005", ref: "QT-2024-0110", client: "C-1005", date: d(-20), validUntil: d(-6), currency: "USD", freight: 4200, status: "Rejected", orderId: null, items: [{ product: "P-3001", qty: 40, price: 420 }], notes: "Client chose another forwarder." }
    ],

    /* ---- 2. SALES ORDERS (linked to quote, shipment, invoice) ---- */
    sap_orders: [
      { id: "O-5001", ref: "SO-2024-0341", client: "C-1004", date: d(-7), status: "Shipped", currency: "USD", freight: 6200, quoteId: "Q-4001", shipmentId: "SH-7001", invoiceId: "I-9001", items: [{ product: "P-3001", qty: 80, price: 420 }, { product: "P-3008", qty: 120, price: 54 }] },
      { id: "O-5002", assignedTo: "U-002", ref: "SO-2024-0342", client: "C-1002", date: d(-5), status: "Confirmed", currency: "EUR", freight: 2400, quoteId: "Q-4002", shipmentId: null, invoiceId: null, items: [{ product: "P-3004", qty: 40, price: 980 }, { product: "P-3005", qty: 12, price: 3100 }] },
      { id: "O-5003", ref: "SO-2024-0343", client: "C-1001", date: d(-9), status: "Shipped", currency: "USD", freight: 8800, quoteId: null, shipmentId: "SH-7002", invoiceId: "I-9002", items: [{ product: "P-3001", qty: 60, price: 420 }] },
      { id: "O-5004", assignedTo: "U-002", ref: "SO-2024-0344", client: "C-1007", date: d(-2), status: "Pending", currency: "USD", freight: 0, quoteId: null, shipmentId: null, invoiceId: null, items: [{ product: "P-3006", qty: 200, price: 38 }, { product: "P-3008", qty: 90, price: 54 }] },
      { id: "O-5005", ref: "SO-2024-0345", client: "C-1003", date: d(-3), status: "Confirmed", currency: "USD", freight: 0, quoteId: null, shipmentId: null, invoiceId: "I-9005", items: [{ product: "P-3002", qty: 30, price: 165 }] },
      { id: "O-5006", ref: "SO-2024-0346", client: "C-1008", date: d(-12), status: "Completed", currency: "EUR", freight: 3400, quoteId: null, shipmentId: "SH-7007", invoiceId: "I-9003", items: [{ product: "P-3004", qty: 25, price: 980 }] },
      { id: "O-5007", ref: "SO-2024-0347", client: "C-1006", date: d(-1), status: "Cancelled", currency: "USD", freight: 0, quoteId: null, shipmentId: null, invoiceId: null, items: [{ product: "P-3003", qty: 10, price: 690 }] }
    ],

    /* ---- 3a. SHIPMENTS (linked to order, with cost breakdown) ---- */
    sap_shipments: [
      { id: "SH-7001", ref: "MRV-RW-24-118", client: "C-1004", orderId: "O-5001", mode: "Railway", origin: "Mersin, TR", destination: "Baku, AZ", containers: 12, weightTons: 28, status: "In Transit", departed: d(-6), eta: d(2), stockDeducted: true, docs: ["Bill of Lading", "Customs Declaration", "Packing List"], costs: { freight: 4200, customs: 1100, insurance: 600 },
        tracking: [
          { ts: ts(6, 8), status: "Booked", location: "Mersin, TR", note: "Booking confirmed, wagons allocated", by: "Selin Korkmaz" },
          { ts: ts(6, 18), status: "Departed", location: "Mersin Rail Terminal, TR", note: "Train departed on schedule", by: "Selin Korkmaz" },
          { ts: ts(3, 11), status: "In Transit", location: "Kars border, TR", note: "Cleared TR exit, crossing into Georgia corridor", by: "System" }
        ] },
      { id: "SH-7002", ref: "MRV-RW-24-119", client: "C-1001", orderId: "O-5003", mode: "Railway", origin: "Halkalı, TR", destination: "Moscow, RU", containers: 20, weightTons: 27, status: "Customs", departed: d(-9), eta: d(1), stockDeducted: true, docs: ["Bill of Lading", "Certificate of Origin", "Insurance"], costs: { freight: 6400, customs: 1700, insurance: 800 },
        tracking: [
          { ts: ts(9, 9), status: "Departed", location: "Halkalı, TR", note: "Departed Istanbul hub", by: "Selin Korkmaz" },
          { ts: ts(2, 14), status: "Customs", location: "Belgorod, RU", note: "Held for customs inspection — documents under review", by: "System" }
        ] },
      { id: "SH-7003", ref: "MRV-FS-24-205", client: "C-1002", orderId: null, mode: "Road", origin: "Mersin, TR", destination: "Gaziantep, TR", containers: 4, weightTons: 18, status: "Delivered", departed: d(-14), eta: d(-11), docs: ["Delivery Note", "Health Certificate"], costs: { freight: 900, customs: 0, insurance: 120 },
        tracking: [
          { ts: ts(14, 7), status: "Departed", location: "Mersin, TR", note: "Reefer trucks dispatched", by: "Selin Korkmaz" },
          { ts: ts(11, 13), status: "Delivered", location: "Gaziantep, TR", note: "Delivered & signed by consignee", by: "System" }
        ] },
      { id: "SH-7004", assignedTo: "U-002", ref: "MRV-RW-24-120", client: "C-1007", orderId: null, mode: "Railway", origin: "Mersin, TR", destination: "Tbilisi, GE", containers: 9, weightTons: 24, status: "Booked", departed: d(3), eta: d(9), docs: ["Booking Confirmation"], costs: { freight: 0, customs: 0, insurance: 0 },
        tracking: [
          { ts: ts(1, 10), status: "Booked", location: "Mersin, TR", note: "Booking created, awaiting wagon allocation", by: "Ayşe Yıldız" }
        ] },
      { id: "SH-7005", assignedTo: "U-002", ref: "MRV-SE-24-061", client: "C-1006", orderId: null, mode: "Sea", origin: "Mersin Port, TR", destination: "Bandar Abbas, IR", containers: 15, weightTons: 26, status: "On Hold", departed: d(1), eta: d(12), docs: ["Bill of Lading", "Customs Declaration"], costs: { freight: 0, customs: 0, insurance: 0 },
        tracking: [
          { ts: ts(2, 9), status: "Booked", location: "Mersin Port, TR", note: "Slot booked on feeder vessel", by: "Ayşe Yıldız" },
          { ts: ts(1, 15), status: "On Hold", location: "Mersin Port, TR", note: "Client compliance check pending — sailing held", by: "Mustafa Başarman" }
        ] },
      { id: "SH-7006", ref: "MRV-RW-24-121", client: "C-1003", orderId: null, mode: "Railway", origin: "Kocaeli, TR", destination: "Baku, AZ", containers: 11, weightTons: 28, status: "In Transit", departed: d(-3), eta: d(5), docs: ["Bill of Lading", "Dangerous Goods", "Packing List"], costs: { freight: 3900, customs: 1000, insurance: 500 },
        tracking: [
          { ts: ts(3, 8), status: "Departed", location: "Kocaeli, TR", note: "Dangerous-goods manifest verified, departed", by: "Selin Korkmaz" },
          { ts: ts(1, 12), status: "In Transit", location: "Tbilisi, GE", note: "Transit through Georgia, on schedule", by: "System" }
        ] },
      { id: "SH-7007", ref: "MRV-FS-24-206", client: "C-1008", orderId: "O-5006", mode: "Road", origin: "Antalya, TR", destination: "Mersin, TR", containers: 6, weightTons: 22, status: "Delivered", departed: d(-20), eta: d(-18), stockDeducted: true, docs: ["Delivery Note", "Health Certificate", "Invoice"], costs: { freight: 1400, customs: 0, insurance: 200 },
        tracking: [
          { ts: ts(20, 6), status: "Departed", location: "Antalya, TR", note: "Citrus load collected from union depot", by: "Ayşe Yıldız" },
          { ts: ts(18, 17), status: "Delivered", location: "Mersin Cold Store, TR", note: "Received into cold storage", by: "System" }
        ] }
    ],

    /* ---- 3b. SALES INVOICES / receivables (linked to order, with payments) ---- */
    sap_invoices: [
      { id: "I-9001", assignedTo: "U-003", no: "INV-2024-1187", client: "C-1004", order: "O-5001", issued: d(-7), due: d(23), amount: 40080, paid: 0, currency: "USD", status: "Sent", vatRate: 0, vatAmount: 0, totalAmount: 40080 },
      { id: "I-9002", no: "INV-2024-1188", client: "C-1001", order: "O-5003", issued: d(-9), due: d(21), amount: 25200, paid: 10000, currency: "USD", status: "Partial", vatRate: 0, vatAmount: 0, totalAmount: 25200 },
      { id: "I-9003", no: "INV-2024-1170", client: "C-1008", order: "O-5006", issued: d(-12), due: d(-2), amount: 24500, paid: 0, currency: "EUR", status: "Overdue", vatRate: 20, vatAmount: 4900, totalAmount: 29400 },
      { id: "I-9004", no: "INV-2024-1165", client: "C-1002", order: null, issued: d(-30), due: d(-1), amount: 76400, paid: 76400, currency: "EUR", status: "Paid", vatRate: 0, vatAmount: 0, totalAmount: 76400 },
      { id: "I-9005", assignedTo: "U-003", no: "INV-2024-1190", client: "C-1003", order: "O-5005", issued: d(-3), due: d(27), amount: 4950, paid: 0, currency: "USD", status: "Draft", vatRate: 20, vatAmount: 990, totalAmount: 5940 },
      { id: "I-9006", no: "INV-2024-1150", client: "C-1007", order: null, issued: d(-45), due: d(-15), amount: 12300, paid: 14760, currency: "USD", status: "Paid", vatRate: 20, vatAmount: 2460, totalAmount: 14760 }
    ],

    /* ---- 4a. PURCHASE ORDERS (procurement from suppliers) ---- */
    sap_purchaseorders: [
      { id: "PO-6001", ref: "PUR-2024-0061", supplier: "S-2001", date: d(-15), currency: "EUR", status: "Received", billId: "B-8001", warehouse: "Mersin Main", items: [{ product: "P-3001", name: "Nano-Z Industrial Coating 20L", qty: 100, price: 300 }] },
      { id: "PO-6002", ref: "PUR-2024-0058", supplier: "S-2005", date: d(-22), currency: "EUR", status: "Received", billId: "B-8002", warehouse: "Mersin Cold Store", items: [{ product: "P-3004", name: "Antalya Citrus — Class I (1t)", qty: 60, price: 800 }] },
      { id: "PO-6003", assignedTo: "U-002", ref: "PUR-2024-0063", supplier: "S-2004", date: d(-3), currency: "EUR", status: "Sent", billId: null, warehouse: "Istanbul DC", items: [{ product: null, name: "CNC machine spare parts", qty: 2, price: 12000 }] },
      { id: "PO-6004", assignedTo: "U-002", ref: "PUR-2024-0064", supplier: "S-2002", date: d(-1), currency: "USD", status: "Draft", billId: null, warehouse: "Mersin Main", items: [{ product: "P-3006", name: "Refined Sunflower Oil 20L", qty: 200, price: 30 }] }
    ],

    /* ---- 4b. SUPPLIER BILLS / payables (linked to PO, with payments) ---- */
    sap_bills: [
      { id: "B-8001", no: "BILL-2024-0091", supplier: "S-2001", po: "PO-6001", issued: d(-15), due: d(15), amount: 30000, paid: 0, currency: "EUR", status: "Unpaid" },
      { id: "B-8002", no: "BILL-2024-0084", supplier: "S-2005", po: "PO-6002", issued: d(-22), due: d(-2), amount: 48000, paid: 48000, currency: "EUR", status: "Paid" }
    ],

    /* ---- 5. PAYMENTS LEDGER (cash in from clients, cash out to suppliers) ---- */
    sap_payments: [
      { id: "PM-9504", ref: "PAY-2024-0204", kind: "in", party: "Nestlé MENA", doc: "I-9004", date: d(-2), amount: 76400, currency: "EUR", method: "Bank transfer" },
      { id: "PM-9503", ref: "PAY-2024-0203", kind: "in", party: "Gazprom Neft Trading", doc: "I-9002", date: d(-1), amount: 10000, currency: "USD", method: "Bank transfer" },
      { id: "PM-9502", ref: "PAY-2024-0188", kind: "in", party: "Georgian Trade Partners", doc: "I-9006", date: d(-40), amount: 12300, currency: "USD", method: "Bank transfer" },
      { id: "PM-9501", ref: "PAY-2024-0181", kind: "out", party: "Antalya Citrus Union", doc: "B-8002", date: d(-20), amount: 48000, currency: "EUR", method: "Bank transfer" }
    ],

    /* ---- 6. NOTIFICATIONS / WORK QUEUE (drives the "My Work" inbox) ----
       Handoffs and mentions addressed to a specific employee. The urgent
       bucket (overdue invoices, stuck shipments, low stock) is computed
       live from the data above, so it needs no seed rows. */
    sap_notifications: [
      { id: "N-001", ts: ts(0, 9),  to: "U-002", fromName: "Ayşe Yıldız",     type: "handoff", title: "New order to book",       body: "Order SO-2024-0342 (Nestlé MENA) confirmed — create the shipment.",                 entity: "order",         entityId: "O-5002", link: "#/orders",     read: false },
      { id: "N-002", ts: ts(0, 11), to: "U-002", fromName: "Burak Demir",      type: "mention", title: "Burak mentioned you",    body: "@Selin did SH-7002 clear customs before the 14th? Need it for the invoice.",           entity: "shipment",      entityId: "SH-7002", link: "#/shipments",  read: false },
      { id: "N-003", ts: ts(1, 10), to: "U-002", fromName: "System",           type: "task",    title: "Confirm received stock", body: "PO-2024-0064 goods arriving at Mersin Main — confirm the count to close it.",         entity: "purchaseorder", entityId: "PO-6004", link: "#/purchasing", read: false },
      { id: "N-004", ts: ts(0, 10), to: "U-003", fromName: "Selin Korkmaz",    type: "handoff", title: "Invoice ready to issue", body: "Shipment for order SO-2024-0346 delivered — issue the client invoice.",                entity: "order",         entityId: "O-5006", link: "#/finance",    read: false },
      { id: "N-005", ts: ts(2, 11), to: "U-003", fromName: "System",           type: "task",    title: "Follow up payment",      body: "Invoice INV-2024-1187 was sent 7 days ago — send a reminder to Azerbaijan Railways.",  entity: "invoice",       entityId: "I-9001", link: "#/finance",    read: false },
      { id: "N-006", ts: ts(1, 14), to: "U-004", fromName: "System",           type: "task",    title: "Quote awaiting reply",   body: "QT-2024-0123 sent to Georgian Trade Partners — chase for confirmation.",               entity: "quote",         entityId: "Q-4003", link: "#/quotes",     read: false },
      { id: "N-007", ts: ts(1, 15), to: "U-001", fromName: "System",           type: "info",    title: "Shipment on hold",       body: "SH-7005 to Bandar Abbas is held pending the client compliance check.",                 entity: "shipment",      entityId: "SH-7005", link: "#/shipments",  read: false },
      { id: "N-008", ts: ts(3, 9),  to: "U-001", fromName: "System",           type: "info",    title: "Overdue receivable",     body: "INV-2024-1170 (Mersin Free Zone Foods) is overdue — €24,500 outstanding.",             entity: "invoice",       entityId: "I-9003", link: "#/finance",    read: true  }
    ],

    sap_audit: [
      { id:"AT01", ts:ts(0,8),  actor:"Selin Korkmaz",    action:"update", entity:"shipment",      entityId:"SH-7001", summary:"Shipment MRV-RW-24-118 moved to In Transit" },
      { id:"AT02", ts:ts(0,9),  actor:"Selin Korkmaz",    action:"create", entity:"shipment",      entityId:"SH-7009", summary:"Booked new shipment MRV-RW-24-125 to Moscow" },
      { id:"AT03", ts:ts(0,10), actor:"Burak Demir",      action:"create", entity:"invoice",       entityId:"I-9010", summary:"Issued invoice INV-2024-1200 for $22,000" },
      { id:"AT04", ts:ts(0,11), actor:"Mustafa Başarman", action:"create", entity:"client",        entityId:"C-1009", summary:"Onboarded new client: Baku Energy Partners" },
      { id:"AT05", ts:ts(0,12), actor:"Mustafa Başarman", action:"update", entity:"order",         entityId:"O-5002", summary:"Advanced order SO-2024-0342 to Shipped" },
      { id:"AT06", ts:ts(0,13), actor:"Ayşe Yıldız",      action:"create", entity:"quote",         entityId:"Q-4006", summary:"Created quote QT-2024-0130 for BASF Türk" },
      { id:"AD1A", ts:ts(1,8),  actor:"Selin Korkmaz",    action:"update", entity:"shipment",      entityId:"SH-7002", summary:"Tracking update: Kars border cleared" },
      { id:"AD1B", ts:ts(1,9),  actor:"Selin Korkmaz",    action:"update", entity:"order",         entityId:"O-5001", summary:"Order SO-2024-0341 → Shipped" },
      { id:"AD1C", ts:ts(1,10), actor:"Burak Demir",      action:"update", entity:"invoice",       entityId:"I-9004", summary:"Invoice INV-2024-1165 marked Paid (€76,400)" },
      { id:"AD1D", ts:ts(1,11), actor:"Mustafa Başarman", action:"create", entity:"supplier",      entityId:"S-2006", summary:"Added supplier: Russian Grain Export" },
      { id:"AD1E", ts:ts(1,14), actor:"Ayşe Yıldız",      action:"update", entity:"quote",         entityId:"Q-4002", summary:"Quote QT-2024-0119 accepted" },
      { id:"AD1F", ts:ts(1,15), actor:"Ayşe Yıldız",      action:"create", entity:"order",         entityId:"O-5008", summary:"Created order SO-2024-0350 for Nestlé" },
      { id:"AD2A", ts:ts(2,9),  actor:"Selin Korkmaz",    action:"create", entity:"shipment",      entityId:"SH-7006", summary:"Booked MRV-RW-24-121 to Baku" },
      { id:"AD2B", ts:ts(2,10), actor:"Selin Korkmaz",    action:"update", entity:"purchaseorder", entityId:"PO-6001", summary:"Received PO into Mersin Main (+100)" },
      { id:"AD2C", ts:ts(2,11), actor:"Burak Demir",      action:"create", entity:"invoice",       entityId:"I-9001", summary:"Issued invoice INV-2024-1187 for $40,080" },
      { id:"AD2D", ts:ts(2,12), actor:"Burak Demir",      action:"create", entity:"payment",       entityId:"PM-9504", summary:"Recorded €76,400 payment from Nestlé MENA" },
      { id:"AD2E", ts:ts(2,13), actor:"Mustafa Başarman", action:"create", entity:"client",        entityId:"C-1008", summary:"Onboarded Mersin Free Zone Foods" },
      { id:"AD2F", ts:ts(2,15), actor:"Ayşe Yıldız",      action:"update", entity:"client",        entityId:"C-1001", summary:"Updated Gazprom Neft contact details" },
      { id:"AD3A", ts:ts(3,9),  actor:"Selin Korkmaz",    action:"update", entity:"shipment",      entityId:"SH-7003", summary:"Shipment MRV-SEA-24-009 departed Istanbul" },
      { id:"AD3B", ts:ts(3,10), actor:"Burak Demir",      action:"update", entity:"invoice",       entityId:"I-9002", summary:"Invoice sent to Gazprom Neft Trading" },
      { id:"AD3C", ts:ts(3,14), actor:"Mustafa Başarman", action:"update", entity:"order",         entityId:"O-5003", summary:"Order confirmed with Gazprom Neft" },
      { id:"AD3D", ts:ts(3,16), actor:"Ayşe Yıldız",      action:"create", entity:"quote",         entityId:"Q-4005", summary:"Quote for Limak Holding $168,000" },
      { id:"AD5A", ts:ts(5,9),  actor:"Selin Korkmaz",    action:"create", entity:"shipment",      entityId:"SH-7007", summary:"New multimodal shipment booked to Tehran" },
      { id:"AD5B", ts:ts(5,11), actor:"Selin Korkmaz",    action:"update", entity:"shipment",      entityId:"SH-7004", summary:"Customs cleared for MRV-SEA-24-009" },
      { id:"AD5C", ts:ts(5,13), actor:"Burak Demir",      action:"create", entity:"invoice",       entityId:"I-9005", summary:"Invoice for BASF Türk €48,000" },
      { id:"AD5D", ts:ts(5,14), actor:"Mustafa Başarman", action:"update", entity:"order",         entityId:"O-5006", summary:"Order SO-2024-0346 marked Completed" },
      { id:"AD7A", ts:ts(7,9),  actor:"Mustafa Başarman", action:"login",  entity:"session",       entityId:"U-001", summary:"Owner signed in" },
      { id:"AD7B", ts:ts(7,10), actor:"Selin Korkmaz",    action:"update", entity:"order",         entityId:"O-5004", summary:"Order advanced to Confirmed" },
      { id:"AD7C", ts:ts(7,11), actor:"Burak Demir",      action:"update", entity:"invoice",       entityId:"I-9003", summary:"Partial payment recorded $10,000" },
      { id:"AD7D", ts:ts(7,15), actor:"Ayşe Yıldız",      action:"update", entity:"client",        entityId:"C-1007", summary:"Georgian Trade Partners contract updated" },
      { id:"AD10A",ts:ts(10,9), actor:"Selin Korkmaz",    action:"create", entity:"shipment",      entityId:"SH-7005", summary:"Road shipment booked to Tehran" },
      { id:"AD10B",ts:ts(10,10),actor:"Selin Korkmaz",    action:"update", entity:"shipment",      entityId:"SH-7001", summary:"ETA revised +1 day due to delays" },
      { id:"AD10C",ts:ts(10,11),actor:"Burak Demir",      action:"create", entity:"invoice",       entityId:"I-9006", summary:"Invoice for Georgian Trade Partners $12,300" },
      { id:"AD10D",ts:ts(10,14),actor:"Mustafa Başarman", action:"create", entity:"order",         entityId:"O-5009", summary:"Created order SO-2024-0355" },
      { id:"AD10E",ts:ts(10,15),actor:"Ayşe Yıldız",      action:"update", entity:"quote",         entityId:"Q-4003", summary:"Follow-up sent for QT-2024-0123" },
      { id:"AD14A",ts:ts(14,9), actor:"Selin Korkmaz",    action:"update", entity:"shipment",      entityId:"SH-7002", summary:"Shipment MRV-RW-24-110 delivered Baku" },
      { id:"AD14B",ts:ts(14,10),actor:"Burak Demir",      action:"update", entity:"invoice",       entityId:"I-9001", summary:"Payment received $40,080" },
      { id:"AD14C",ts:ts(14,13),actor:"Mustafa Başarman", action:"update", entity:"client",        entityId:"C-1004", summary:"Azerbaijan Railways contract renewed" },
      { id:"AD14D",ts:ts(14,15),actor:"Ayşe Yıldız",      action:"create", entity:"quote",         entityId:"Q-4007", summary:"Quote for Tehran Industrial Group $28,000" },
      { id:"AD18A",ts:ts(18,8), actor:"Selin Korkmaz",    action:"create", entity:"purchaseorder", entityId:"PO-6003", summary:"PO raised for TCDD Logistics" },
      { id:"AD18B",ts:ts(18,10),actor:"Burak Demir",      action:"create", entity:"invoice",       entityId:"I-9007", summary:"Invoice for Limak Holding $18,200" },
      { id:"AD18C",ts:ts(18,14),actor:"Mustafa Başarman", action:"create", entity:"quote",         entityId:"Q-4008", summary:"Strategic quote for Nestlé MENA renewal" },
      { id:"AD22A",ts:ts(22,9), actor:"Selin Korkmaz",    action:"update", entity:"shipment",      entityId:"SH-7003", summary:"Customs cleared MRV-SEA-24-009" },
      { id:"AD22B",ts:ts(22,11),actor:"Burak Demir",      action:"update", entity:"invoice",       entityId:"I-9007", summary:"Payment reminder sent to Limak Holding" },
      { id:"AD22C",ts:ts(22,14),actor:"Mustafa Başarman", action:"update", entity:"order",         entityId:"O-5007", summary:"Order SO-2024-0347 cancelled" },
      { id:"AD27A",ts:ts(27,10),actor:"Selin Korkmaz",    action:"create", entity:"shipment",      entityId:"SH-7008", summary:"New rail booking Mersin → Moscow" },
      { id:"AD27B",ts:ts(27,11),actor:"Burak Demir",      action:"create", entity:"invoice",       entityId:"I-9008", summary:"Invoice for Gazprom Neft $55,000" },
      { id:"AD27C",ts:ts(27,14),actor:"Mustafa Başarman", action:"create", entity:"client",        entityId:"C-1010", summary:"New client: Aliyev & Partners, Baku" }
    ]
  };
};
