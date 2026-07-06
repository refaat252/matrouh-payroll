// ====================================================
//  Configuration
// ====================================================

let CONFIG;

try {
    const configModule = await import('./config.js');
    CONFIG = configModule.CONFIG;
} catch (e) {
    console.error('[CONFIG] Failed to load config.js:', e);
    CONFIG = {
        API_URL: 'https://script.google.com/macros/s/AKfycbztZXccO_cDgD57zSPrt5sZT_6r36va7eSXnXIDZiColDdON3lAZ-OidOTnU2JRYL-onA/exec',
        API_KEY: 'XyZ@2025!Secure'
    };
}

// ====================================================
//  Constants
// ====================================================

const CACHE_KEY = 'payroll_search_cache';
const CACHE_EXPIRY = 24 * 60 * 60 * 1000;
const AUTO_CLEAR_TIMEOUT = 30 * 60 * 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

// ====================================================
//  State
// ====================================================

let currentUser = null;
let isPaymentsExpanded = true;
let autoClearTimer = null;
let modalFocusTrap = null;

// ====================================================
//  Utilities
// ====================================================

function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

function normalizeKey(k) {
    return k ? k.toString().trim().normalize('NFKC') : '';
}

function formatCurrency(value) {
    if (value === null || value === undefined || value === '') return '—';
    const num = parseFloat(value);
    if (isNaN(num)) return String(value);
    return num.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' ج.م';
}

function formatNumber(value) {
    if (value === null || value === undefined || value === '') return '—';
    const num = parseFloat(value);
    if (isNaN(num)) return String(value);
    return num.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function validateEgyptianNationalId(id) {
    if (!/^\d{14}$/.test(id)) return false;
    const century = id[0] === '2' ? 1900 : id[0] === '3' ? 2000 : null;
    if (!century) return false;
    const year = century + parseInt(id.substring(1, 3));
    const month = parseInt(id.substring(3, 5));
    const day = parseInt(id.substring(5, 7));
    const birthDate = new Date(year, month - 1, day);
    if (birthDate.getFullYear() !== year || birthDate.getMonth() !== month - 1 || birthDate.getDate() !== day) {
        return false;
    }
    const govCode = parseInt(id.substring(7, 9));
    const validGovCodes = [1, 2, 3, 4, 11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32, 33, 34, 35, 88];
    if (!validGovCodes.includes(govCode)) return false;
    return true;
}

function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
    const controller = new AbortController();
    const timeout = options.timeout || 10000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);

        if (retries > 0 && error.name !== 'AbortError') {
            console.warn(`[FETCH] Retry ${MAX_RETRIES - retries + 1}/${MAX_RETRIES}`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            return fetchWithRetry(url, options, retries - 1);
        }

        throw error;
    }
}

// ====================================================
//  Cache Management
// ====================================================

function getCachedResult(nationalId) {
    try {
        const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        const cached = cache[nationalId];

        if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY) {
            console.log('[CACHE] Hit for:', nationalId);
            return cached.data;
        }

        if (cached) {
            delete cache[nationalId];
            localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        }
    } catch (e) {
        console.error('[CACHE] Read error:', e);
    }
    return null;
}

function cacheResult(nationalId, data) {
    try {
        const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        cache[nationalId] = { data, timestamp: Date.now() };
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
        console.error('[CACHE] Write error:', e);
    }
}

function clearCache(nationalId = null) {
    try {
        if (nationalId) {
            const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
            delete cache[nationalId];
            localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        } else {
            localStorage.removeItem(CACHE_KEY);
        }
    } catch (e) {
        console.error('[CACHE] Clear error:', e);
    }
}

// ====================================================
//  Auto Clear
// ====================================================

function scheduleDataClear() {
    if (autoClearTimer) clearTimeout(autoClearTimer);
    autoClearTimer = setTimeout(() => {
        clearAllData();
        showDataClearNotification();
    }, AUTO_CLEAR_TIMEOUT);
}

function clearAllData() {
    currentUser = null;
    document.getElementById('email-input').value = '';
    document.getElementById('national-id-input').value = '';
    document.getElementById('result-section').style.display = 'none';
    document.querySelector('.search-container').style.display = 'block';
    document.getElementById('instructions-section').style.display = 'block';
    clearCache();
}

function showDataClearNotification() {
    const notification = document.createElement('div');
    notification.className = 'data-clear-notification';
    notification.innerHTML = `
        <i class="fas fa-info-circle mr-2" aria-hidden="true"></i>
        تم مسح البيانات تلقائيًا لأغراض الأمان
    `;
    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), 5000);
}

// ====================================================
//  API Functions (GET for search, POST FormData for update)
// ====================================================

async function searchUser(nationalId, email) {
    try {
        // Check cache first
        const cached = getCachedResult(nationalId);
        if (cached) {
            return processSearchResult(cached, email);
        }

        // ✅ GET request — no CORS Preflight!
        const url = new URL(CONFIG.API_URL);
        url.searchParams.append('key', CONFIG.API_KEY);
        url.searchParams.append('action', 'search');
        url.searchParams.append('nationalId', nationalId);

        const response = await fetchWithRetry(url.toString(), {
            method: 'GET',
            timeout: 15000
        });

        const result = await response.json();

        if (result.success) {
            cacheResult(nationalId, result);
            return processSearchResult(result, email);
        }

        return { user: null, message: result.error || 'لم يتم العثور على المستخدم' };
    } catch (error) {
        console.error('[API] Search failed:', error);
        return { user: null, message: 'فشل الاتصال بالخادم: ' + error.message };
    }
}

function processSearchResult(result, email) {
    const registeredEmail = (result.data['البريد'] || '').trim();

    if (registeredEmail && registeredEmail.toLowerCase() === email.toLowerCase()) {
        scheduleDataClear();
        return { user: result.data, message: 'تم العثور على المستخدم' };
    } else if (!registeredEmail) {
        scheduleDataClear();
        return { user: result.data, message: 'البريد غير مسجل', requiresUpdate: true };
    } else {
        return { user: null, message: 'البريد الإلكتروني المدخل غير متطابق مع البريد المسجل' };
    }
}

async function updateUserEmail(nationalId, newEmail) {
    try {
        // ✅ POST with URLSearchParams (FormData) — no CORS Preflight!
        const formData = new URLSearchParams();
        formData.append('key', CONFIG.API_KEY);
        formData.append('action', 'updateEmail');
        formData.append('nationalId', nationalId);
        formData.append('email', newEmail);

        const response = await fetchWithRetry(CONFIG.API_URL, {
            method: 'POST',
            body: formData,
            // ❌ NO custom headers! Let browser set Content-Type automatically
            timeout: 15000
        });

        const result = await response.json();

        if (result.success) {
            clearCache(nationalId);
            return { success: true, message: result.message || 'تم التحديث بنجاح' };
        }

        return { success: false, message: result.error || 'فشل التحديث' };
    } catch (error) {
        console.error('[API] Update failed:', error);
        return { success: false, message: 'فشل الاتصال بالخادم: ' + error.message };
    }
}

// ====================================================
//  UI Functions
// ====================================================

function makeInfoRow(label, value, iconClass, isCurrency = false) {
    const tpl = document.getElementById('info-row-template');
    const clone = tpl.content.cloneNode(true);
    const labelEl = clone.querySelector('.info-label');
    const valueEl = clone.querySelector('.info-value');
    const item = clone.querySelector('.info-item');

    const safeValue = (value !== null && value !== undefined) ? String(value) : '';

    if (safeValue && safeValue.includes('متأخرات')) {
        item.classList.add('highlight-red');
    }

    if (iconClass) {
        const icon = document.createElement('i');
        icon.className = `fas ${iconClass} ml-2 text-blue-500`;
        icon.setAttribute('aria-hidden', 'true');
        labelEl.appendChild(icon);
    }

    labelEl.appendChild(document.createTextNode(label));
    valueEl.textContent = isCurrency ? formatCurrency(safeValue) : safeValue;

    return clone;
}

function clearElement(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
}

function togglePaymentSection() {
    const section = document.getElementById('payments-section');
    const btn = document.getElementById('payments-toggle-btn');

    isPaymentsExpanded = !isPaymentsExpanded;
    section.classList.toggle('collapsed', !isPaymentsExpanded);
    btn.classList.toggle('collapsed', !isPaymentsExpanded);
}

function showResult(user) {
    document.querySelector('.search-container').style.display = 'none';
    document.getElementById('instructions-section').style.display = 'none';
    document.getElementById('error-section').style.display = 'none';
    document.getElementById('result-section').style.display = 'block';
    document.getElementById('result-section').style.animation = 'slideInUp 0.4s ease-out';

    // Sticky header - Employee Data Grid (2 columns)
    const stickyContainer = document.getElementById('sticky-header-container');
    clearElement(stickyContainer);

    const stickyFields = [
        { key: 'الاسم', label: 'الاسم', icon: 'fa-user' },
        { key: 'الرقم القومى', label: 'الرقم القومي', icon: 'fa-id-card' },
        { key: 'الدرجة', label: 'الدرجة', icon: 'fa-star' },
        { key: 'الحالة الاجتماعية', label: 'الحالة الاجتماعية', icon: 'fa-people-arrows' },
        { key: 'اساسى 30/6', label: 'أساسي 2014', icon: 'fa-coins', isCurrency: true },
        { key: 'اساسى يوليو 2025', label: 'أساسي يوليو 2026', icon: 'fa-coins', isCurrency: true },
        { key: 'عدد التذاكر', label: 'عدد التذاكر', icon: 'fa-ticket-alt' }
    ];

    stickyFields.forEach(field => {
        let value = user[normalizeKey(field.key)];
        if (!value && field.key === 'اساسى 30/6') {
            value = user['اساسى 2014'] || user[normalizeKey('اساسى 2014')];
        }
        if (!value && field.key === 'اساسى يوليو 2025') {
            value = user['اساسى يوليو 2026'] || user[normalizeKey('اساسى يوليو 2026')] || user['اساسى يوليو 2025'];
        }
        if (!value && field.key === 'عدد التذاكر') {
            value = user['عدد التذاكر'] || user['عدد_التذاكر'] || user['تذاكر'] || '';
        }
        if (value) {
            const row = document.createElement('div');
            row.className = 'sticky-header-row';
            const displayValue = field.isCurrency ? formatCurrency(value) : escapeHTML(String(value));
            row.innerHTML = `
                <div class="sticky-header-label">
                    <i class="fas ${field.icon}" aria-hidden="true"></i>
                    ${field.label}
                </div>
                <div class="sticky-header-item">${displayValue}</div>
            `;
            stickyContainer.appendChild(row);
        }
    });

    // Data container
    const dataContainer = document.getElementById('user-data');
    clearElement(dataContainer);

    // ===== PAYMENTS SECTION (المدفوعات الإضافية) =====
    const excludeFields = [
        'الاسم', 'الرقم القومى', 'الدرجة', 'الحالة الاجتماعية', 'عدد التذاكر',
        'اساسى 30/6', 'اساسى يوليو 2025', 'اساسى 2014', 'اساسى يوليو 2026',
        'البريد', 'نقدى مايو 2026', 'نقدى_مايو_2026',
        'اساسى يوليو 2026', 'اساسى يوليو 2025'
    ];

    const paymentItems = [];
    Object.keys(user).forEach(key => {
        const normalized = normalizeKey(key);
        if (!excludeFields.some(f => normalizeKey(f) === normalized)) {
            const value = user[key];
            if (value) paymentItems.push({ key, value });
        }
    });

    if (paymentItems.length > 0) {
        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'payments-toggle-btn';
        toggleBtn.className = 'collapse-toggle-btn';
        toggleBtn.type = 'button';
        toggleBtn.innerHTML = `
            <div class="flex items-center">
                <i class="fas fa-list-ul ml-2" aria-hidden="true"></i>
                <span>المدفوعات الإضافية</span>
            </div>
            <i class="fas fa-chevron-down toggle-icon" aria-hidden="true"></i>
        `;
        toggleBtn.addEventListener('click', togglePaymentSection);
        dataContainer.appendChild(toggleBtn);

        const paymentsSection = document.createElement('div');
        paymentsSection.id = 'payments-section';
        paymentsSection.className = 'collapsible-payments-section salary-card';

        let totalPayments = 0;
        const paymentList = document.createElement('div');
        paymentList.className = 'divide-y divide-slate-100';

        paymentItems.forEach(({ key, value }) => {
            const numValue = parseFloat(value);
            if (!isNaN(numValue)) totalPayments += numValue;

            const row = document.createElement('div');
            row.className = 'payment-item';
            row.innerHTML = `
                <span class="font-medium text-slate-700">${escapeHTML(key)}</span>
                <span class="amount">${formatCurrency(value)}</span>
            `;
            paymentList.appendChild(row);
        });

        paymentsSection.appendChild(paymentList);

        const totalRow = document.createElement('div');
        totalRow.className = 'total';
        totalRow.innerHTML = `
            <strong>الإجمالي:</strong>
            <strong class="amount">${formatCurrency(totalPayments)}</strong>
        `;
        paymentsSection.appendChild(totalRow);

        dataContainer.appendChild(paymentsSection);
        isPaymentsExpanded = true;
    }
}

function showError(message) {
    document.querySelector('.search-container').style.display = 'block';
    document.getElementById('instructions-section').style.display = 'block';
    document.getElementById('result-section').style.display = 'none';
    const err = document.getElementById('error-section');
    document.getElementById('error-message').textContent = message;
    err.style.display = 'block';
}

// ====================================================
//  Modal with Focus Trap
// ====================================================

function openEmailModal(nationalId, hasEmail, prefilledEmail = '') {
    const modal = document.getElementById('email-modal');
    const overlay = document.getElementById('email-modal-overlay');

    document.getElementById('user-national-id').textContent = nationalId;
    document.getElementById('modal-message').textContent = hasEmail
        ? 'تم العثور على بريد إلكتروني مسجل مسبقًا. يمكنك تحديثه الآن.'
        : 'لم يتم العثور على بريد إلكتروني مرتبط بهذا الرقم القومي. الرجاء إدخال البريد الإلكتروني.';

    document.getElementById('new-email-input').value = prefilledEmail || '';
    document.getElementById('confirm-email-input').value = '';
    document.getElementById('email-error').classList.add('hidden');

    overlay.style.display = 'block';
    modal.style.display = 'block';

    setupFocusTrap(modal);
    document.getElementById('new-email-input').focus();
}

function closeEmailModal() {
    const modal = document.getElementById('email-modal');
    const overlay = document.getElementById('email-modal-overlay');

    modal.style.display = 'none';
    overlay.style.display = 'none';
    document.getElementById('new-email-input').value = '';
    document.getElementById('confirm-email-input').value = '';
    document.getElementById('email-error').classList.add('hidden');

    if (modalFocusTrap) {
        modal.removeEventListener('keydown', modalFocusTrap);
        modalFocusTrap = null;
    }

    document.getElementById('email-input').focus();
}

function setupFocusTrap(modal) {
    const focusableElements = modal.querySelectorAll(
        'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    modalFocusTrap = (e) => {
        if (e.key !== 'Tab') return;

        if (e.shiftKey) {
            if (document.activeElement === firstElement) {
                e.preventDefault();
                lastElement.focus();
            }
        } else {
            if (document.activeElement === lastElement) {
                e.preventDefault();
                firstElement.focus();
            }
        }
    };

    modal.addEventListener('keydown', modalFocusTrap);
}

// ====================================================
//  Event Listeners
// ====================================================

document.getElementById('login-form').addEventListener('submit', async function(event) {
    event.preventDefault();

    const emailInput = document.getElementById('email-input');
    const nationalIdInput = document.getElementById('national-id-input');
    const email = emailInput.value.trim();
    const nationalId = nationalIdInput.value.trim();

    emailInput.classList.remove('input-error');
    nationalIdInput.classList.remove('input-error');
    document.getElementById('error-section').style.display = 'none';
    document.getElementById('result-section').style.display = 'none';
    document.getElementById('update-success').style.display = 'none';

    if (!validateEgyptianNationalId(nationalId)) {
        showError('الرقم القومي يجب أن يتكون من 14 رقمًا صحيحًا (تاريخ ميلاد + محافظة صالحة).');
        nationalIdInput.classList.add('input-error');
        return;
    }

    if (!validateEmail(email)) {
        showError('صيغة البريد الإلكتروني غير صحيحة.');
        emailInput.classList.add('input-error');
        return;
    }

    try {
        localStorage.setItem('last_used_email', email);
    } catch (e) { /* ignore */ }

    const btn = document.getElementById('search-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner" aria-hidden="true"></span> جاري البحث...';

    const result = await searchUser(nationalId, email);

    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-search mr-2" aria-hidden="true"></i> البحث';

    if (result.user) {
        currentUser = result.user;
        if (result.requiresUpdate) {
            openEmailModal(nationalId, false, email);
        } else {
            showResult(result.user);
        }
    } else {
        showError(result.message);
    }
});

document.getElementById('new-search-btn').addEventListener('click', function() {
    clearAllData();
    document.getElementById('email-input').focus();
});

document.getElementById('print-btn')?.addEventListener('click', function() {
    window.print();
});

document.getElementById('close-email-modal').addEventListener('click', closeEmailModal);
document.getElementById('cancel-email-btn').addEventListener('click', closeEmailModal);
document.getElementById('email-modal-overlay').addEventListener('click', closeEmailModal);

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const modal = document.getElementById('email-modal');
        if (modal && modal.style.display === 'block') {
            closeEmailModal();
        }
    }
});

document.getElementById('email-form').addEventListener('submit', async function(event) {
    event.preventDefault();

    const email = document.getElementById('new-email-input').value.trim();
    const confirmEmail = document.getElementById('confirm-email-input').value.trim();
    const nationalId = document.getElementById('user-national-id').textContent;
    const errorElement = document.getElementById('email-error');

    errorElement.classList.add('hidden');

    if (email !== confirmEmail) {
        document.getElementById('email-error-message').textContent = 'البريد الإلكتروني وتأكيده غير متطابقين.';
        errorElement.classList.remove('hidden');
        return;
    }

    if (!validateEmail(email)) {
        document.getElementById('email-error-message').textContent = 'صيغة البريد الإلكتروني غير صحيحة.';
        errorElement.classList.remove('hidden');
        return;
    }

    const saveBtn = document.getElementById('save-email-btn');
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="loading-spinner" aria-hidden="true"></span> جاري الحفظ...';

    const updateResult = await updateUserEmail(nationalId, email);

    saveBtn.disabled = false;
    saveBtn.innerHTML = 'حفظ البريد';

    if (updateResult.success) {
        if (currentUser) currentUser['البريد'] = email;
        closeEmailModal();
        showResult(currentUser);
        const success = document.getElementById('update-success');
        success.style.display = 'flex';
        setTimeout(() => success.style.display = 'none', 5000);
    } else {
        document.getElementById('email-error-message').textContent = updateResult.message;
        errorElement.classList.remove('hidden');
    }
});

// ====================================================
//  Initialization
// ====================================================

try {
    const lastEmail = localStorage.getItem('last_used_email');
    if (lastEmail) {
        document.getElementById('email-input').value = lastEmail;
    }
} catch (e) { /* ignore */ }

document.getElementById('email-input').focus();

console.log('[APP] Initialized successfully');
