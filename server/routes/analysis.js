import { Router } from 'express';
import { summary, trend, top, spikes, newVsRecurring, insights, DIMENSIONS } from '../analysis/queries.js';
import { query } from '../db/pool.js';

export const analysisRouter = Router();

analysisRouter.get('/analysis/summary', async (req, res) => res.json(await summary(req.query)));
analysisRouter.get('/analysis/trend', async (req, res) => res.json(await trend(req.query)));
analysisRouter.get('/analysis/top', async (req, res) => res.json(await top(req.query)));
analysisRouter.get('/analysis/spikes', async (req, res) => res.json(await spikes(req.query)));
analysisRouter.get('/analysis/new-recurring', async (req, res) => res.json(await newVsRecurring(req.query)));
analysisRouter.get('/analysis/insights', async (req, res) => res.json(await insights(req.query)));

analysisRouter.get('/analysis/dimensions', (_req, res) =>
  res.json(Object.entries(DIMENSIONS).map(([key, d]) => ({ key, label: d.label }))),
);

analysisRouter.get('/categories', async (_req, res) => {
  const { rows } = await query('SELECT code, label, sort_order FROM reason_categories ORDER BY sort_order, code');
  res.json(rows);
});
