import sys
import os
import fpdf

class PDF(fpdf.FPDF):
    def header(self):
        if self.page_no() == 1:
            return  # Kapak sayfasinda ustbilgiyi gizle
        self.set_font('Helvetica', 'B', 9)
        self.set_text_color(16, 42, 69)  # #102a45 navy
        self.cell(100, 10, 'MERVEKS SAP - MUSTERI SISTEM DOKUMANTASYONU', 0, 0, 'L')
        self.set_font('Helvetica', '', 8)
        self.set_text_color(100, 116, 139)  # slate
        self.cell(0, 10, 'Sistem Kilavuzu & Teknik Detaylar', 0, 1, 'R')
        self.set_draw_color(226, 232, 240)
        self.line(10, 18, 200, 18)
        self.ln(3)

    def footer(self):
        self.set_y(-15)
        self.set_draw_color(226, 232, 240)
        self.line(10, 282, 200, 282)
        self.set_font('Helvetica', 'I', 8)
        self.set_text_color(148, 163, 184)
        self.cell(120, 10, 'Gizli - MERVEKS Musteri ve Ortaklari Icin Hazirlanmistir', 0, 0, 'L')
        self.cell(0, 10, f'Sayfa {self.page_no()}/{{nb}}', 0, 0, 'R')

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
    # ok basligi sag
    pdf.line(x2, y, x2 - 3, y - 2)
    pdf.line(x2, y, x2 - 3, y + 2)

def draw_arrow_v(pdf, x, y1, y2, color=(26, 166, 223), double=False):
    pdf.set_draw_color(*color)
    pdf.set_line_width(0.7)
    pdf.line(x, y1, x, y2)
    # ok basligi asagi
    pdf.line(x, y2, x - 2, y2 - 3)
    pdf.line(x, y2, x + 2, y2 - 3)
    if double:
        # ok basligi yukari
        pdf.line(x, y1, x - 2, y1 + 3)
        pdf.line(x, y1, x + 2, y1 + 3)

def create_guide(filename):
    pdf = PDF()
    pdf.alias_nb_pages()
    
    # ---------------- KAPAK SAYFASI ----------------
    pdf.add_page()
    pdf.set_fill_color(16, 42, 69)  # #102a45
    pdf.rect(0, 0, 210, 297, 'F')
    
    # Mavi serit
    pdf.set_draw_color(26, 166, 223)  # #1aa6df blue
    pdf.set_line_width(2)
    pdf.line(20, 45, 190, 45)
    
    # Baslik
    pdf.ln(50)
    pdf.set_font('Helvetica', 'B', 32)
    pdf.set_text_color(255, 255, 255)
    pdf.cell(0, 15, 'MERVEKS SAP', 0, 1, 'L')
    
    pdf.set_font('Helvetica', 'B', 16)
    pdf.set_text_color(26, 166, 223)
    pdf.cell(0, 10, 'Kurumsal Operasyonlar ve Finans Konsolu', 0, 1, 'L')
    
    pdf.ln(80)
    pdf.set_font('Helvetica', '', 11)
    pdf.set_text_color(148, 163, 184)
    pdf.cell(0, 6, 'Musteri Kullanici Kilavuzu & Sistem El Kitabi', 0, 1, 'L')
    pdf.cell(0, 6, 'Surum: 1.0 (Canli Dagitim)', 0, 1, 'L')
    pdf.cell(0, 6, 'Tarih: Haziran 2026', 0, 1, 'L')
    pdf.cell(0, 6, 'Adres: https://merveks-sap.vercel.app', 0, 1, 'L')
    
    # ---------------- ICINDEKILER ----------------
    pdf.add_page()
    pdf.set_text_color(16, 42, 69)
    pdf.set_font('Helvetica', 'B', 18)
    pdf.cell(0, 10, 'Icindekiler', 0, 1, 'L')
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
        
    toc_line('1.', 'Yonetici Ozet', '3')
    toc_line('2.', 'Sistem Mimarisi ve Teknoloji Yigini', '3')
    toc_line('3.', 'Sistem Operasyonel Is Akisi', '4')
    toc_line('4.', 'Satis ve Siparis Yonetimi (Musteri Akisi)', '5')
    toc_line('5.', 'Lojistik ve Kargo Takibi (QR Etiketleme)', '5')
    toc_line('6.', 'Satinalma ve Envanter Kontrolu', '6')
    toc_line('7.', 'Finans, Muhasebe ve Yapay Zeka Muhasebecisi', '7')
    toc_line('8.', 'Rol Tabanli Erisim Kontrolleri (RBAC) Detaylari', '8')
    toc_line('9.', 'Arayuz Ozellestirmeleri ve Ayarlar', '8')
    toc_line('10.', 'Erisim Talimatlari ve Hizli Baslangic', '9')
    toc_line('11.', 'Sistem Arayuzu Ekran Goruntuleri', '10')
    
    # ---------------- SAYFA 3: OZET & MIMARI ----------------
    pdf.add_page()
    
    # Bolum 1
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '1. Yonetici Ozeti', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p1 = (
        "MERVEKS SAP Konsolu; MERVEKS kurumsal yapisi altindaki uluslararasi ticaret "
        "operasyonlarini, kargo lojistigini, depolamayi, tedariki ve sirket muhasebesini "
        "tek bir noktadan yonetmek uzere tasarlanmis guvenli ve modern bir ERP web uygulamasidir. "
        "Gida tedarik zincirinden demiryolu tasimaciligina, Nano-Z kaplama dagitimindan "
        "lojistik operasyonlarina kadar tum surecler bu platform uzerinden izlenebilir.\n\n"
        "Kullanim kolayligi, yuksek hiz ve responsive tasarim odakli gelistirilen bu uygulama, "
        "kullanicilara yetkileri dahilinde ozellesmis moduller sunar. Musteri taleplerinin alinmasi, "
        "tekliflerin olusturulmasi, kargo takibi, tedarik faturalarinin girilmesi ve nakit akis "
        "kontrolu gibi kurumsal her islem sisteme anlik islenir, yetki kontrolunden gecer ve denetlenir."
    )
    pdf.multi_cell(0, 5.5, p1)
    pdf.ln(5)
    
    # Bolum 2
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '2. Sistem Mimarisi ve Teknoloji Yigini', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p2 = (
        "Sistem, yuksek hiz ve maksimum guvenilirlik sunmak amaciyla modern ve harici "
        "kutuphanelerden bagimsiz bir istemci tarafi (client-side) mimari kullanmaktadir:\n"
        "- Arayuz Modeli: Standart HTML5 ve Vanilla CSS degiskenleri ile Jost & Inter tipografisi.\n"
        "- Uygulama Mantigi: Bilesen bazli (component-driven) ES6 Javascript. Agir web framework "
        "kutuphaneleri yerine dogrudan tarayicida çalisan temiz IIFE yapisi sayesinde yuklenme suresi 1 saniyenin altindadir.\n"
        "- Veri & Baglanti Katmani: Cevrimdisi yuksek performans için yerel tarayici depolamasi (IndexedDB/Store) "
        "ve MERVEKS ERP REST API'leri ile anlik senkronizasyon yetenegi.\n"
        "- Guvenlik: Istemci tarafli dinamik yonlendirme (routing) kontrolleri ve bilesen bazli RBAC filtreleri.\n"
        "- Dagitim: Vercel Edge Server sunuculari uzerinde tam otomatik entegrasyon."
    )
    pdf.multi_cell(0, 5.5, p2)
    
    # ---------------- SAYFA 4: AKIS DIAGRAMI ----------------
    pdf.add_page()
    
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '3. Sistem Operasyonel Is Akisi', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p3 = (
        "Konsol; satis, envanter, lojistik ve finans sureclerini tek bir web "
        "arayuzunde birlestirir. Asagidaki sematik akis diyagrami, bu kurumsal bilesenlerin "
        "birbiriyle nasil dinamik bir baglanti icinde calistigini gostermektedir:"
    )
    pdf.multi_cell(0, 5.5, p3)
    pdf.ln(5)
    
    # Akis diyagramini ciz (y=55)
    # 1. Satir: Satis -> Lojistik
    draw_box(pdf, 15, 55, 42, 14, 'Teklifler (Satis)', 'Fiyat teklifi olusturma')
    draw_arrow_h(pdf, 57, 62, 82)
    
    draw_box(pdf, 82, 55, 42, 14, 'Siparisler', 'Musteri talebinin onaylanmasi')
    draw_arrow_h(pdf, 124, 62, 149)
    
    draw_box(pdf, 149, 55, 44, 14, 'Kargo Sevkiyatlari', 'Demiryolu/Deniz lojistigi')
    
    # 2. Satir: Satinalma -> Envanter
    draw_box(pdf, 15, 90, 42, 14, 'Satin Alma Siparisleri', 'Tedarikci islemleri')
    draw_arrow_h(pdf, 57, 97, 82)
    
    draw_box(pdf, 82, 90, 42, 14, 'Envanter Stogu', 'Depo miktarlari')
    
    # 3. Satir: Finans Defteri
    draw_box(pdf, 62, 130, 80, 16, 'Finans Defteri & Muhasebe', 'Faturalar, Odemeler ve Gelir-Gider', fill_color=(240, 249, 255))
    
    # 4. Satir: Gemini Yapay Zeka
    draw_box(pdf, 62, 170, 80, 16, 'Gemini YZ Motoru', 'AI Muhasebeci & Ekip Denetimi', fill_color=(250, 245, 255), border_color=(109, 79, 206))
    
    # Dikey baglantilar
    draw_arrow_v(pdf, 171, 69, 130)  # Sevkiyat -> Finans
    draw_arrow_v(pdf, 103, 104, 130)  # Envanter -> Finans
    draw_arrow_v(pdf, 36, 104, 130)  # POs -> Finans
    draw_arrow_v(pdf, 102, 146, 170, color=(109, 79, 206), double=True)  # Finans <-> Gemini YZ
    
    pdf.set_xy(10, 200)
    pdf.set_font('Helvetica', 'I', 9.5)
    pdf.set_text_color(100, 116, 139)
    p3_note = (
        "Not: Veritabanindaki her guncelleme Islem Gecmisi (Audit) defterine loglanir. "
        "Stok seviyeleri, satinalma siparisleri teslim alindiginda anlik olarak artar, "
        "kargo gonderimlerinde duser. Yapay zeka modulu canli veriyi okuyarak analiz sunar."
    )
    pdf.multi_cell(0, 5, p3_note)
    
    # ---------------- SAYFA 5: SATIS & LOJISTIK ----------------
    pdf.add_page()
    
    # Bolum 4
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '4. Satis ve Siparis Yonetimi (Musteri Akisi)', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p4 = (
        "Satis surecleri Fiyat Teklifleri ve Siparisler bilesenleri uzerinden ilerler:\n"
        "- Fiyat Teklifleri (Quotations): Satis temsilcileri musteriler icin kur (USD, EUR, TRY), "
        "odeme vadesi ve kalem bazli birim fiyatlar iceren teklifler tasarlar. Onaylanan teklifler "
        "'Kabul Et ve Siparis Olustur' butonu ile tek adimda aktif bir siparise donusturulur.\n"
        "- Siparisler (Sales Orders): Onaylanan siparislerin durumunu (Taslak, Onaylandi, Sevk Edildi, Iptal) "
        "anlik takip eder. Siparis detay panelleri dinamik yetkilendirme filtresine tabi tutulur."
    )
    pdf.multi_cell(0, 5.5, p4)
    pdf.ln(5)
    
    # Bolum 5
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '5. Lojistik ve Kargo Takibi (QR Etiketleme)', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p5 = (
        "Kargo lojistigi, uluslararasi yuklerin anlik takibi icin tasarlanmistir:\n"
        "- Operasyonel Detaylar: Sevkiyat rotalari, tasima modu (Demiryolu, Deniz, Karayolu), "
        "konteyner sayilari ve net tonaj degerleri.\n"
        "- Rota Zaman Tüneli: Operatorler kargonun bulundugu kontrol noktalarini (Mersin, Istanbul vb.) "
        "guncel durum notlari ile sisteme kaydeder.\n"
        "- QR Entegrasyonu: 'Etiket Yazdir' butonu ile olusturulan QR barkodlu sevkiyat etiketleri, "
        "mobil cihazlar uzerinden taranarak kargo durumunun anlik guncellenmesine olanak saglar.\n"
        "- Kamuya Acik Takip Portali: Musteriler kargo kodunu tarayarak sisteme giris yapmadan "
        "konteyner adetleri, rota bilgileri, ETA (tahmini varis) ve canli hareket gecmisini gorebilir."
    )
    pdf.multi_cell(0, 5.5, p5)
    
    # ---------------- SAYFA 6: SATINALMA & ENVANTER ----------------
    pdf.add_page()
    
    # Bolum 6
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '6. Satinalma ve Envanter Kontrolu', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p6 = (
        "Envanter stoklari ve tedarik sureci satin alma islemleriyle entegre yonetilir:\n"
        "- Satin Alma Siparisleri (PO): Tedarikcilerden alinacak urunler icin PO kayitlari girilir. "
        "Mal kabul yapildiginda, 'Teslim Al ve Fatura Olustur' butonu depodaki stok miktarlarini "
        "ilgili urun icin otomatik artirir ve tedarikci adina odenmemis bir fatura kaydeder.\n"
        "- Dusuk Stok Alarmi: Stok yonetim sistemi depo limitlerini anlik izler. "
        "Urun miktari onceden tanimlanmis kritik sinirin altina dustugunde arayuzde 'Dusuk Stok' "
        "uyarisi gosterilerek satin alma siparisi olusturulmasi tetiklenir.\n"
        "- Depolama Merkezleri: Sirketin farkli depolarindaki (Mersin Ana Depo, Istanbul DC) urun "
        "dagilimini ve toplam stok degerini gosterir."
    )
    pdf.multi_cell(0, 5.5, p6)
    
    # ---------------- SAYFA 7: FINANS & YAPAY ZEKA ----------------
    pdf.add_page()
    
    # Bolum 7
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '7. Finans, Muhasebe ve Yapay Zeka Muhasebecisi', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p7 = (
        "Sistem, yapay zeka entegrasyonuna sahip kurumsal muhasebe defterleri barindirir:\n"
        "- Finans Defteri: Aktif Alacaklar (AR) ve Borclar (AP) dengesini tutar. Kaydedilen tahsilat ve "
        "odeme hareketleri sirket net nakit akisini ve K/Z (Kar/Zarar) tablosunu anlik dengeler.\n"
        "- Alacak Yaslandirma: Musterilerin odenmemis borclarini chronological periyotlara "
        "(Vadesi gelmemis, 1-30 gun, 31-60 gun, 60+ gun gecikmis) gore gruplar ve grafiksel barlarla listeler.\n"
        "- PDF & Excel Dosyalari: Sirket finansal raporlarini ve bireysel faturalari tek tikla yazdirilabilir "
        "PDF olarak olusturur. Tablo uzerindeki butonlar ile fatura dokumleri alinabilir, Excel ile CSV indirilebilir.\n"
        "- Gemini AI Muhasebeci: Google Gemini API'si uzerinden calisir. Acik faturalari analiz eder, "
        "musteri odeme aliskanliklarini inceler ve kurumsal kredi risk raporu hazirlar. Gecikmis alacaklar icin "
        "tahsilat stratejileri onerir.\n"
        "- Yapay Zeka Performans & Maas Artisi Onerileri: Calisanlarin islem kayitlarini analiz ederek "
        "performans indekslerini (Kalite, Istikrar, Gelir Etkisi, Kidem) olusturur. YZ motoru bu analizle "
        "calisanlar icin yillik maas artisi oranlari (+%8 - +%15 arasi) veya PIP (Performans Gelistirme Plani) onerir."
    )
    pdf.multi_cell(0, 5.5, p7)
    
    # ---------------- SAYFA 8: RBAC & ARAYUZ ----------------
    pdf.add_page()
    
    # Bolum 8
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '8. Rol Tabanli Erisim Kontrolleri (RBAC) Detaylari', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p8 = (
        "Veri guvenligi icin bilesen bazli yetkilendirme kurallari uygulanir:\n"
        "- Kurucu (Owner): Sinirsiz sistem yetkisi. Maas ayarlamalarini yapma, zam kaydetme, "
        "Islem Gecmisi (Audit) timeline'ini tam olarak gorme ve veritabani silme islemlerini yapabilir.\n"
        "- Operasyon Yoneticisi: Lojistik, envanter, satin alma ve satis siparislerine erisir. Finansal "
        "veriler (AR/AP, Kar marjlari, gelir-gider trendleri) bu role tamamen kapatilmistir. Yonetici paneli "
        "linkleri gizlenir ve URL uzerinden dogrudan erisim denemeleri router tarafindan engellenerek dashboard'a yonlendirilir.\n"
        "- Finans Yetkilisi: Sadece faturalar, borc-alacak dengesi, odemeler ve YZ muhasebe raporlarina erisir. "
        "Lojistik, envanter ve satis islemleri bu role kapatilmistir.\n"
        "- Ticaret Uzmani: Teklifler, siparisler ve musteriler uzerinde calisir. Sistem bilesenlerini ve verileri silme yetkisi yoktur."
    )
    pdf.multi_cell(0, 5.5, p8)
    pdf.ln(5)
    
    # Bolum 9
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '9. Arayuz Ozellestirmeleri ve Ayarlar', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p9 = (
        "Kullanici deneyimini artirmak icin sirket standartlarinda tasarimlar uygulanmistir:\n"
        "- Katlanabilir Kenar Cubugu: Sol paneldeki 'MENU' butonu ile sidebar gizlenebilir. Bu sayede calisma "
        "alani genisler. Durum tarayici bellegine (localStorage) kaydedilerek korunur.\n"
        "- Ozellesmis Dil Secenegi: Sag ust kosede Turkce, English ve Rusca secimi sunan, merveks.com tasarimina "
        "uygun olarak dizayn edilmis (kirmizi cerceveli, keskin kenarli ve mavi secim durumlu) premium dil dropdown'i bulunur.\n"
        "- Kullanici Profil Sayfasi: Sag ustteki isim kartina tiklandiginda acilir. Calisanin kendi maas "
        "gecmisini, YZ performans skorlarini ve son yaptigi islemlerin listesini gosterir."
    )
    pdf.multi_cell(0, 5.5, p9)
    
    # ---------------- SAYFA 9: ERISIM & HIZLI BASLANGIC ----------------
    pdf.add_page()
    
    # Bolum 10
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '10. Erisim Talimatlari ve Hizli Baslangic', 0, 1, 'L')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(30, 41, 59)
    
    p10 = (
        "Konsola erismek ve sistemi test etmek icin:\n"
        "1. Canli adresi acin: https://merveks-sap.vercel.app\n"
        "2. Giris sayfasindaki demo bilgileri ile oturum acin:\n"
        "   - Kurucu (Owner): owner@merveks.com (Sifre: merveks2013)\n"
        "   - Operasyon: operations@merveks.com (Sifre: ops123)\n"
        "   - Finans: finance@merveks.com (Sifre: fin123)\n"
        "3. Farkli dil seceneklerini test etmek icin sag ustteki dropdown'i kullanin.\n"
        "4. Sol paneli gizlemek/gostermek icin MENU butonuna tiklayin.\n"
        "5. Muhasebe sayfasinda Gemini AI Muhasebe analizini veya PDF/Excel aktarimini deneyin.\n"
        "6. Sag ustteki profil kartiniza tiklayarak performans karne barlarinizi inceleyin."
    )
    pdf.multi_cell(0, 5.5, p10)
    
    # ---------------- SAYFA 10: EKRAN GORUNTULERI SAYFA 1 ----------------
    pdf.add_page()
    pdf.set_font('Helvetica', 'B', 14)
    pdf.set_text_color(16, 42, 69)
    pdf.cell(0, 10, '11. Sistem Arayuzu Ekran Goruntuleri', 0, 1, 'L')
    pdf.ln(3)
    
    pdf.set_font('Helvetica', 'B', 10)
    pdf.cell(0, 6, 'Sekil 1: Operasyon Konsolu Kontrol Paneli (Genel Gorunum)', 0, 1, 'L')
    pdf.image('assets/guide/media__1782351606542.png', x=15, y=32, w=180, h=95)
    
    pdf.set_xy(10, 135)
    pdf.cell(0, 6, 'Sekil 2: Fiyat Teklifleri ve Satis Siparisleri Modulu', 0, 1, 'L')
    pdf.image('assets/guide/media__1782354398692.png', x=15, y=144, w=180, h=95)
    
    # ---------------- SAYFA 11: EKRAN GORUNTULERI SAYFA 2 ----------------
    pdf.add_page()
    pdf.ln(5)
    
    pdf.set_font('Helvetica', 'B', 10)
    pdf.cell(0, 6, 'Sekil 3: Lojistik Kargo Takibi ve QR Barkod Etiketleri', 0, 1, 'L')
    pdf.image('assets/guide/media__1782355913569.png', x=15, y=25, w=180, h=95)
    
    pdf.set_xy(10, 130)
    pdf.cell(0, 6, 'Sekil 4: Calisan Performans Raporu ve Maas Karne Ekrani', 0, 1, 'L')
    pdf.image('assets/guide/media__1782351906846.png', x=15, y=138, w=180, h=95)
    
    pdf.output(filename)

if __name__ == '__main__':
    filename = 'MERVEKS_SAP_Musteri_Kilavuzu.pdf'
    if len(sys.argv) > 1:
        filename = sys.argv[1]
    create_guide(filename)
    print(f"Successfully generated PDF: {filename}")
