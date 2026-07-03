import sys
import os
import fpdf

class PDF(fpdf.FPDF):
    def header(self):
        if self.page_no() == 1:
            return  # Suppress header on cover page
        self.set_font('Helvetica', 'B', 9)
        self.set_text_color(16, 42, 69)  # #102a45 navy
        self.cell(100, 10, 'MERVEKS SAP - CLIENT SYSTEM DOCUMENTATION', 0, 0, 'L')
        self.set_font('Helvetica', '', 8)
        self.set_text_color(100, 116, 139)  # slate
        self.cell(0, 10, 'System Guide & Specifications', 0, 1, 'R')
        self.set_draw_color(226, 232, 240)
        self.line(10, 18, 200, 18)
        self.ln(3)

    def footer(self):
        self.set_y(-15)
        self.set_draw_color(226, 232, 240)
        self.line(10, 282, 200, 282)
        self.set_font('Helvetica', 'I', 8)
        self.set_text_color(148, 163, 184)
        self.cell(120, 10, 'Confidential - Prepared for MERVEKS Clients & Partners', 0, 0, 'L')
        self.cell(0, 10, f'Page {self.page_no()}/{{nb}}', 0, 0, 'R')

def draw_box(pdf, x, y, w, h, title, subtitle, fill_color=(248, 250, 252), border_color=(16, 42, 69), text_color=(100, 116, 139)):
    pdf.set_fill_color(*fill_color)
    pdf.set_draw_color(*border_color)
    pdf.set_line_width(0.4)
    pdf.rect(x, y, w, h, 'FD')
    
    # Title
    pdf.set_font('Helvetica', 'B', 8.5)
    pdf.set_text_color(*border_color)
    pdf.set_xy(x, y + 2.5)
    pdf.cell(w, 4, title, 0, 1, 'C')
    
    # Subtitle
    pdf.set_font('Helvetica', '', 7.5)
    pdf.set_text_color(*text_color)
    pdf.set_xy(x, y + 7)
    pdf.cell(w, 4, subtitle, 0, 1, 'C')

def draw_arrow_h(pdf, x1, y, x2, color=(26, 166, 223)):
    pdf.set_draw_color(*color)
    pdf.set_line_width(0.7)
    pdf.line(x1, y, x2, y)
    # arrow head pointing right
    pdf.line(x2, y, x2 - 3, y - 2)
    pdf.line(x2, y, x2 - 3, y + 2)

def draw_arrow_v(pdf, x, y1, y2, color=(26, 166, 223), double=False):
    pdf.set_draw_color(*color)
    pdf.set_line_width(0.7)
    pdf.line(x, y1, x, y2)
    # arrow head pointing down
    pdf.line(x, y2, x - 2, y2 - 3)
    pdf.line(x, y2, x + 2, y2 - 3)
    if double:
        # arrow head pointing up
        pdf.line(x, y1, x - 2, y1 + 3)
        pdf.line(x, y1, x + 2, y1 + 3)

def create_guide(filename):
    pdf = PDF()
    pdf.alias_nb_pages()
    
    # ---------------- COVER PAGE ----------------
    pdf.add_page()
    pdf.set_fill_color(16, 42, 69)  # #102a45
    pdf.rect(0, 0, 210, 297, 'F')
    
    # Brand line
    pdf.set_draw_color(26, 166, 223)  # #1aa6df blue
    pdf.set_line_width(2)
    pdf.line(20, 45, 190, 45)
    
    # Title
    pdf.ln(50)
    pdf.set_font('Helvetica', 'B', 32)
    pdf.set_text_color(255, 255, 255)
    pdf.cell(0, 15, 'MERVEKS SAP', 0, 1, 'L')
    
    pdf.set_font('Helvetica', 'B', 16)
    pdf.set_text_color(26, 166, 223)
    pdf.cell(0, 10, 'Enterprise Operations & Finance Console', 0, 1, 'L')
    
    pdf.ln(80)
    pdf.set_font('Helvetica', '', 11)
    pdf.set_text_color(148, 163, 184)
    pdf.cell(0, 6, 'Client User Guide & System Manual', 0, 1, 'L')
    pdf.cell(0, 6, 'Version: 1.0 (Production Release)', 0, 1, 'L')
    pdf.cell(0, 6, 'Date: June 2026', 0, 1, 'L')
    pdf.cell(0, 6, 'Host: https://merveks-sap.vercel.app', 0, 1, 'L')
    
    # ---------------- TABLE OF CONTENTS ----------------
    pdf.add_page()
    pdf.set_text_color(16, 42, 69)
    pdf.set_font('Helvetica', 'B', 18)
    pdf.cell(0, 10, 'Table of Contents', 0, 1, 'L')
    pdf.ln(10)
    
    def toc_line(num, text, page):
        pdf.set_font('Helvetica', 'B', 11)
        pdf.set_text_color(16, 42, 69)
        pdf.cell(10, 8, num, 0, 0)
        pdf.set_font('Helvetica', '', 11)
        pdf.set_text_color(30, 41, 59)
        pdf.cell(150, 8, text, 0, 0)
        pdf.set_font('Helvetica', 'B', 11)
        pdf.set_text_color(16, 42, 69)
        pdf.cell(0, 8, page, 0, 1, 'R')
        
    toc_line('1.', 'Executive Summary', '3')
    toc_line('2.', 'System Architecture & Tech Stack', '3')
    toc_line('3.', 'System Operational Workflow', '4')
    toc_line('4.', 'Sales & Order Management (Client Pipeline)', '5')
    toc_line('5.', 'Logistics & Cargo Tracking (QR Labeling)', '5')
    toc_line('6.', 'Procurement & Inventory Control', '6')
    toc_line('7.', 'Finance, Accounting & AI Accountant', '7')
    toc_line('8.', 'Role-Based Access Controls (RBAC) Details', '8')
    toc_line('9.', 'Interface Customizations & Settings', '8')
    toc_line('10.', 'Access Instructions & Quickstart', '9')
    toc_line('11.', 'System Interface Screenshots', '10')
    
    # ---------------- PAGE 3: SUMMARY & TECH STACK ----------------
    pdf.add_page()
    
    # Section 1
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '1. Executive Summary', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p1 = (
        "The MERVEKS SAP Console is a secure, state-of-the-art Web ERP application "
        "designed to manage international trade operations, cargo logistics, warehousing, "
        "procurement, and corporate accounting for MERVEKS. From overseeing food supply chains "
        "and railway freight routes to coating distribution logistics, this platform "
        "serves as a single point of operational visibility.\n\n"
        "Built with a focus on ease of use, responsiveness, and speed, the application "
        "equips team members with specialized modules tailored to their corporate roles. "
        "Every operation - whether recording client requests, issuing sales quotes, tracking cargo loads, "
        "logging supplier bills, or balancing cash flows - is fully tracked, permission-gated, and audited."
    )
    pdf.multi_cell(0, 5.5, p1)
    pdf.ln(5)
    
    # Section 2
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '2. System Architecture & Tech Stack', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p2 = (
        "The system utilizes a modern, zero-dependency client-side architecture to deliver high speed "
        "and maximum reliability:\n"
        "- Frontend Shell: Standard HTML5 and Vanilla CSS variables with custom Jost & Inter typography.\n"
        "- Application Logic: Component-driven modular ES6 Javascript. It follows a clean IIFE "
        "architecture that eliminates dependencies on heavy web frameworks, ensuring sub-second load times.\n"
        "- Data & Connection Layer: Connected to local indexed storage for offline performance and "
        "configured to synchronize with the MERVEKS ERP REST APIs. Disconnecting enters the mock sandbox mode.\n"
        "- Security: Client-side routing checks and strict role boundary validations at the component level.\n"
        "- Deployment: Hosted and built automatically via Vercel Edge Server infrastructure."
    )
    pdf.multi_cell(0, 5.5, p2)
    
    # ---------------- PAGE 4: OPERATIONAL WORKFLOW (DIAGRAM) ----------------
    pdf.add_page()
    
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '3. System Operational Workflow', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p3 = (
        "The console coordinates sales, inventory, logistics, and finance "
        "into a single unified web portal. The flowchart below illustrates how these "
        "entities connect and work together dynamically:"
    )
    pdf.multi_cell(0, 5.5, p3)
    pdf.ln(5)
    
    # Draw Flowchart (y starting at 55)
    # Row 1: Sales -> Logistics
    draw_box(pdf, 15, 55, 42, 14, 'Quotations (Sales)', 'Draft price offers')
    draw_arrow_h(pdf, 57, 62, 82)
    
    draw_box(pdf, 82, 55, 42, 14, 'Sales Orders', 'Confirmed client demands')
    draw_arrow_h(pdf, 124, 62, 149)
    
    draw_box(pdf, 149, 55, 44, 14, 'Cargo Shipments', 'Railway/Sea logistics')
    
    # Row 2: Procurement -> Inventory
    draw_box(pdf, 15, 90, 42, 14, 'Purchase Orders', 'Supplier procurement')
    draw_arrow_h(pdf, 57, 97, 82)
    
    draw_box(pdf, 82, 90, 42, 14, 'Inventory Stock', 'Warehouse counts')
    
    # Row 3: Finance Ledger
    draw_box(pdf, 62, 130, 80, 16, 'Finance Ledger & Accounting', 'Invoices, Bills, Payments & P&L', fill_color=(240, 249, 255))
    
    # Row 4: Gemini AI Engine
    draw_box(pdf, 62, 170, 80, 16, 'Gemini AI Engine', 'AI Accountant & HR Audit', fill_color=(250, 245, 255), border_color=(109, 79, 206))
    
    # Draw vertical connectors
    draw_arrow_v(pdf, 171, 69, 130)  # Shipments -> Finance
    draw_arrow_v(pdf, 103, 104, 130)  # Inventory -> Finance
    draw_arrow_v(pdf, 36, 104, 130)  # POs -> Finance
    draw_arrow_v(pdf, 102, 146, 170, color=(109, 79, 206), double=True)  # Finance <-> Gemini AI
    
    pdf.set_xy(10, 200)
    pdf.set_font('Helvetica', 'I', 9.5)
    pdf.set_text_color(100, 116, 139)
    p3_note = (
        "Note: Every database modification logs audit records in the Activity History ledger. "
        "Stock values recalculate dynamically when POs are received (replenishing warehouse) "
        "or cargo is dispatched. The AI accountant processes the live ledger to flag risk and credit."
    )
    pdf.multi_cell(0, 5, p3_note)
    
    # ---------------- PAGE 5: SALES & LOGISTICS ----------------
    pdf.add_page()
    
    # Section 4
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '4. Sales & Order Management (Client Pipeline)', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p4 = (
        "The sales module is structured around Quotations and Orders, reducing manual steps:\n"
        "- Quotations: Trade specialists can draft detailed quotes for prospects, selecting the client, "
        "currency (USD, EUR, TRY), payment terms, and adding multiple line items with specific unit prices. "
        "Approved quotes transition to orders with a single click on 'Accept & Create Order'.\n"
        "- Sales Orders: Tracks active orders through confirmation, shipping, completion, or cancellation. "
        "Order pages gate access dynamically, preventing unauthorized modifications."
    )
    pdf.multi_cell(0, 5.5, p4)
    pdf.ln(5)
    
    # Section 5
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '5. Logistics & Cargo Tracking (QR Labeling)', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p5 = (
        "Logistics tracking is designed for high-resolution tracking of international cargo:\n"
        "- Core Metrics: Tracks origin, destination, transport mode (Railway, Sea, Land), weight in tons, "
        "and container quantities.\n"
        "- Route Timeline: Operators record tracking check-ins (checkpoints) to chart transit progress.\n"
        "- QR Labeling: Clicking 'Print Label' opens a layout containing a system-generated QR code. "
        "Field workers can print this label and scan it with a mobile camera via the built-in scanner to update checkpoints.\n"
        "- Public Tracking Portal: Clients scan the QR code to open the public tracking portal. "
        "They see routes, container counts, departed dates, ETA, and live timelines without needing login credentials."
    )
    pdf.multi_cell(0, 5.5, p5)
    
    # ---------------- PAGE 6: PROCUREMENT & INVENTORY ----------------
    pdf.add_page()
    
    # Section 6
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '6. Procurement & Inventory Control', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p6 = (
        "Inventory levels and supply lines are kept in balance via integrated PO operations:\n"
        "- Purchase Orders (PO): Purchase orders are logged to suppliers to replenish warehouse stock. "
        "When a PO is received physically, clicking 'Receive & Create Bill' automatically increments stock "
        "levels for the related product and creates an unpaid supplier bill in the accounting ledger.\n"
        "- Low Stock Warnings: The inventory system constantly monitors product counts. "
        "If warehouse quantities fall below the pre-configured reorder threshold, visual warnings like "
        "'Low Stock' are triggered, prompting trade managers to issue purchase orders.\n"
        "- Warehousing Facilities: Tracks storage locations (e.g. Mersin Main, Istanbul DC) and displays "
        "total estimated inventory value in real-time."
    )
    pdf.multi_cell(0, 5.5, p6)
    
    # ---------------- PAGE 7: FINANCE & SMART AI ----------------
    pdf.add_page()
    
    # Section 7
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '7. Finance, Accounting & AI Accountant', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p7 = (
        "The system offers advanced finance ledgers integrated with AI automation:\n"
        "- Finance Ledger: Tracks active Receivables (AR) and Payables (AP). Payments recorded in the system "
        "automatically recalculate the net cash flow and balance sheet figures.\n"
        "- Aging Receivables: Computes outstanding customer debt and groups it into chronological periods "
        "(Current, 1-30 days, 31-60 days, 60+ days) represented by visual progress bars.\n"
        "- PDF & Excel Sheets: Generates detailed statements and individual invoice documents with a single click. "
        "Row actions inside the ledger allow printing separate invoice sheets, and 'Export Excel' downloads formatted CSV data.\n"
        "- Gemini AI Accountant: Powered by Google Gemini. Evaluates open invoices, reviews payment history, "
        "and drafts a credit-risk report. It identifies overdue clients, analyzes collection speed, and suggests "
        "mitigation strategies.\n"
        "- AI Performance & Raise Recommendations: The system computes employee rankings using multivariable "
        "metrics (Quality, Consistency, Revenue impact, and Seniority). Based on these metrics, the AI suggests "
        "annual raise options (e.g. +8% to +11%) or flags a Performance Improvement Plan (PIP) if a user requires support."
    )
    pdf.multi_cell(0, 5.5, p7)
    
    # ---------------- PAGE 8: RBAC DETAILS & CUSTOMIZATIONS ----------------
    pdf.add_page()
    
    # Section 8
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '8. Role-Based Access Controls (RBAC) Details', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p8 = (
        "Strict permission boundaries protect corporate databases and govern system views:\n"
        "- Owner: Has absolute system permission. Only owners can access margins, see complete audit "
        "timelines, customize employee account stats, log salary raises, or delete database elements.\n"
        "- Operations Manager: Scoped to transport, logistics, inventory stock, and orders. Sidebar "
        "automatically filters out AR/AP tabs, salary details, profit & loss, and margins. Direct URL route "
        "tampering attempts are blocked by the router and redirect managers back to the dashboard.\n"
        "- Finance Officer: Scoped to accounting ledger, client billing, payments, and AI auditing. Sidebar "
        "only lists Dashboard, Clients, and Finance. Direct operations tabs are gated and completely locked.\n"
        "- Trade Specialist: Scoped to quotes, orders, and clients. Action buttons to delete entries or modify "
        "team parameters are hidden."
    )
    pdf.multi_cell(0, 5.5, p8)
    pdf.ln(5)
    
    # Section 9
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '9. Interface Customizations & Settings', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p9 = (
        "The interface incorporates premium design choices to elevate user experience:\n"
        "- Collapsible Sidebar: Click 'MENU' next to the three bars to slide the sidebar off-screen, "
        "expanding the workspace. The expanded/collapsed state is saved to browser localStorage.\n"
        "- Custom Language Dropdown: Placed in the top right. Allows changing interface language to Türkçe, "
        "English, or Rusça. Uses the signature merveks.com design (bold red border, sharp corners, and blue selection state).\n"
        "- User Profile Page: Accessible by clicking the top right user menu card. Allows users to view their "
        "role details, performance scores, salary history, raise timeline, and personal activity log."
    )
    pdf.multi_cell(0, 5.5, p9)
    
    # ---------------- PAGE 9: ACCESS & QUICKSTART ----------------
    pdf.add_page()
    
    # Section 10
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '10. Access Instructions & Quickstart', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p10 = (
        "To access the console and start testing the application:\n"
        "1. Open the URL: https://merveks-sap.vercel.app\n"
        "2. Log in using the demo credentials provided on the login page:\n"
        "   - Owner: owner@merveks.com (Password: merveks2013)\n"
        "   - Operations: operations@merveks.com (Password: ops123)\n"
        "   - Finance: finance@merveks.com (Password: fin123)\n"
        "3. Switch languages at the top right to verify localization overrides.\n"
        "4. Collapse the sidebar using the MENU button to verify fullscreen transitions.\n"
        "5. Go to Accounting to test the AI Accountant Gemini analysis or export PDF/Excel statements.\n"
        "6. Click your user card at the top right to inspect your personal employee profile."
    )
    pdf.multi_cell(0, 5.5, p10)
    
    # ---------------- PAGE 10: SCREENSHOTS PAGE 1 ----------------
    pdf.add_page()
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '11. System Interface Screenshots', 0, 1, 'L')
    pdf.ln(3)
    
    pdf.set_font('Helvetica', 'B', 10)
    pdf.cell(0, 6, 'Figure 1: Operations Console Dashboard (Full Overview)', 0, 1, 'L')
    pdf.image('assets/guide/media__1782351606542.png', x=15, y=32, w=180, h=95)
    
    pdf.set_xy(10, 135)
    pdf.cell(0, 6, 'Figure 2: Quotations & Sales Orders Pipeline Management', 0, 1, 'L')
    pdf.image('assets/guide/media__1782354398692.png', x=15, y=144, w=180, h=95)
    
    # ---------------- PAGE 11: SCREENSHOTS PAGE 2 ----------------
    pdf.add_page()
    pdf.ln(5)
    
    pdf.set_font('Helvetica', 'B', 10)
    pdf.cell(0, 6, 'Figure 3: Logistics Checkpoint Tracking & QR Labels', 0, 1, 'L')
    pdf.image('assets/guide/media__1782355913569.png', x=15, y=25, w=180, h=95)
    
    pdf.set_xy(10, 130)
    pdf.cell(0, 6, 'Figure 4: Detailed Employee Performance Profile Dashboard', 0, 1, 'L')
    pdf.image('assets/guide/media__1782351906846.png', x=15, y=138, w=180, h=95)
    
    pdf.output(filename)

if __name__ == '__main__':
    filename = 'MERVEKS_SAP_Client_Guide.pdf'
    if len(sys.argv) > 1:
        filename = sys.argv[1]
    create_guide(filename)
    print(f"Successfully generated PDF: {filename}")
