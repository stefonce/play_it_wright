const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || null;

const ROSA_URL =
  'https://rosa.be/fr/booking/hp/hilde-vernaeve/is-new-patient/?site=67c44339e1d1119bff139da2&skipped-steps=site';

// ---------- Helpers ----------

async function withPage(fn, contextOptions = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function clickIfVisible(locator, timeout = 2000) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
    await locator.first().click();
    return true;
  } catch {
    return false;
  }
}

// ---------- Tervuren (inchangé) ----------

async function checkTervuren() {
  return withPage(async (page) => {
    await page.goto('https://tervuren.mijnafspraakmaken.be/?link=a374', {
      waitUntil: 'networkidle',
    });

    await page.getByText('Verblijf in België regelen', { exact: true }).click();
    await page.getByRole('button', { name: 'Ga verder naar stap 2' }).click();

    await page.getByText('niet-Belg', { exact: true }).click();
    await page.getByRole('button', { name: 'Ga verder naar stap 3' }).click();

    await page.getByText('Ik ben nieuw in België', { exact: false }).click();
    await page.getByRole('button', { name: 'Ga verder naar stap 4' }).click();

    await page.getByText('Ik kom in België werken', { exact: false }).click();
    await page.getByRole('button', { name: 'Ga verder naar stap 5' }).click();

    await page.getByRole('button', { name: 'Ga verder naar stap 6' }).click();
    await page.getByRole('button', { name: 'Ga verder naar stap 7' }).click();

    await page.waitForSelector(
      'text=De eerste mogelijkheid is al voor u ingesteld',
      { timeout: 20000 }
    );
    await page.waitForTimeout(1000);

    const allValues = await page.$$eval('input, select', (els) =>
      els.map((el) => el.value).filter(Boolean)
    );

    const dateRegex = /\d{1,2}\s+\p{L}+\s+\d{4}/u;
    const timeRegex = /^\d{1,2}:\d{2}$/;

    const firstAvailableDate = allValues.find((v) => dateRegex.test(v)) || null;
    const firstAvailableTime = allValues.find((v) => timeRegex.test(v)) || null;

    if (!firstAvailableDate) {
      return { error: 'date non trouvée', debugValues: allValues };
    }
    return { firstAvailableDate, firstAvailableTime };
  });
}

// ---------- Rosa (Hilde Vernaeve) ----------

async function checkRosa() {
  return withPage(
    async (page) => {
      await page.goto(ROSA_URL, { waitUntil: 'domcontentloaded' });

      // Bandeau cookies éventuel
      await clickIfVisible(
        page.getByRole('button', { name: /tout accepter|accepter|accept all|j'accepte/i }),
        3000
      );

      // Étape 1 : "Oui, je suis un nouveau patient"
      await page.getByText(/Oui, je suis un nouveau patient/i).first().click();
      await clickIfVisible(
        page.getByRole('button', { name: /suivant|continuer|next/i }),
        2000
      );

      // Étape 2 : "Consultatie" / "Consultation"
      const consultation = page.getByText(/consultati(e|on)/i).first();
      await consultation.waitFor({ state: 'visible' });
      await consultation.click();
      await clickIfVisible(
        page.getByRole('button', { name: /suivant|continuer|next/i }),
        2000
      );

      // Étape 3 : liste des disponibilités ("Choisissez une disponibilité")
      // Structure réelle de la page (attributs data-cy) :
      //   [data-cy="availability-results"]
      //     jour    : [data-cy="availability-results__day-<ts>-<n>"]  -> "Mer. 7 avr. 2027"
      //     créneau : button[data-cy="availability-results__day-slots__slot-<ts>"]
      //     heure   : [data-cy="availability-results__day-slots__slot__time-<ts>"] -> "09h00"
      try {
        await page
          .locator('button[data-cy^="availability-results__day-slots__slot-"]')
          .first()
          .waitFor({ state: 'visible', timeout: 30000 });
      } catch {
        const bodyText = await page.locator('body').innerText();
        return {
          error: 'aucun créneau trouvé',
          debugText: bodyText.slice(0, 1500),
        };
      }

      const result = await page.evaluate(() => {
        const root = document.querySelector('[data-cy="availability-results"]');
        if (!root) return null;

        // Premier en-tête de jour (on exclut les conteneurs "day-slots")
        const dayEl = [...root.querySelectorAll('[data-cy^="availability-results__day-"]')].find(
          (el) => !el.getAttribute('data-cy').startsWith('availability-results__day-slots')
        );

        const slotBtn = root.querySelector(
          'button[data-cy^="availability-results__day-slots__slot-"]'
        );
        const timeEl = root.querySelector(
          '[data-cy^="availability-results__day-slots__slot__time-"]'
        );

        let slot = null;
        try {
          slot = slotBtn ? JSON.parse(slotBtn.value) : null;
        } catch {
          slot = null;
        }

        return {
          date: dayEl ? dayEl.textContent.trim() : null,
          time: timeEl ? timeEl.textContent.trim() : null,
          startUTC: slot ? slot.date : null,
          endUTC: slot ? slot.endDate : null,
        };
      });

      if (!result || !result.date || !result.time) {
        const bodyText = await page.locator('body').innerText();
        return {
          error: 'date ou heure non trouvée',
          result,
          debugText: bodyText.slice(0, 1500),
        };
      }

      return {
        firstAvailableDate: result.date, // ex. "Mer. 7 avr. 2027"
        firstAvailableTime: result.time, // ex. "09h00"
        slotStartUTC: result.startUTC, // ex. "2027-04-07T07:00:00.000Z"
        slotEndUTC: result.endUTC,
      };
    },
    { locale: 'fr-BE' }
  );
}

// ---------- Routes ----------

function guard(handler) {
  return async (req, res) => {
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      res.json(await handler());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

app.get('/tervuren-afspraak', guard(checkTervuren));
app.get('/rosa-rdv', guard(checkRosa));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Scraper service listening on port ${PORT}`);
});
