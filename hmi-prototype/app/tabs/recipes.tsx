'use client';

import { useState } from 'react';
import { useBackend } from '../backend';
import type { Recipe, RecipeLine, Ingredient } from '../sim-data';

export function RecipesTab() {
  const backend = useBackend();
  const recipes: Recipe[] = backend?.recipes ?? [];
  const ingredients: Ingredient[] = backend?.ingredients ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Recipe | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const recipe = recipes.find(r => r.id === selected);

  function startCreate() {
    const nextNum = recipes.length + 1;
    const newRecipe: Recipe = {
      id: `R-${String(nextNum).padStart(2, '0')}`,
      name: '',
      revision: 0,
      mixTime: 180,
      lines: [],
      microLines: [],
    };
    setDraft(newRecipe);
    setSelected(null);
    setEditing(true);
  }

  function startEdit() {
    if (!recipe) return;
    setDraft({ ...recipe, lines: recipe.lines.map(l => ({ ...l })), microLines: recipe.microLines.map(l => ({ ...l })) });
    setEditing(true);
  }

  async function saveDraft() {
    if (!draft || !backend?.connected) return;
    const result = await backend.sendCommand('SaveRecipe', undefined, draft as unknown as Record<string, unknown>);
    if (result.accepted) {
      setSelected(draft.id);
      setEditing(false);
      setDraft(null);
    }
  }

  function cancelEdit() {
    setEditing(false);
    setDraft(null);
  }

  async function doDelete(id: string) {
    if (!backend?.connected) return;
    const result = await backend.sendCommand('RemoveRecipe', id);
    if (result.accepted) {
      if (selected === id) setSelected(null);
      setConfirmDelete(null);
    }
  }

  return (
    <div className="flex gap-3 h-full">
      {/* Recipe list */}
      <div className="w-56 flex-shrink-0 flex flex-col" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '3px' }}>
        <div className="px-3 py-2 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--fg-dim)', fontSize: '11px', fontWeight: 600, letterSpacing: '0.03em' }}>RECIPES</span>
          <button onClick={startCreate} className="px-2 py-1 text-xs font-medium"
            style={{ color: 'var(--accent)', background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>
            + New
          </button>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {recipes.length === 0 && !editing && (
            <div className="px-3 py-4" style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>No recipes</div>
          )}
          {recipes.map(r => (
            <div
              key={r.id}
              onClick={() => { if (!editing) { setSelected(r.id); } }}
              className="px-3 py-2.5"
              style={{
                borderBottom: '1px solid var(--border)',
                background: selected === r.id && !editing ? 'var(--bg-row)' : 'transparent',
                color: selected === r.id && !editing ? 'var(--fg-bright)' : 'var(--fg)',
                cursor: editing ? 'default' : 'pointer',
              }}
            >
              <div style={{ fontWeight: 500, fontSize: '12px' }}>{r.name || r.id}</div>
              <div style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>Rev {r.revision} · {r.mixTime}s mix</div>
            </div>
          ))}
        </div>
      </div>

      {/* Detail / editor */}
      <div className="flex-1" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '3px' }}>
        {editing && draft ? (
          <RecipeEditor
            draft={draft}
            setDraft={setDraft}
            ingredients={ingredients}
            onSave={saveDraft}
            onCancel={cancelEdit}
          />
        ) : recipe ? (
          <RecipeDetail
            recipe={recipe}
            ingredients={ingredients}
            onEdit={startEdit}
            onDelete={() => setConfirmDelete(recipe.id)}
          />
        ) : (
          <div className="flex items-center justify-center h-full" style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>
            Select a recipe or create a new one
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setConfirmDelete(null)}>
          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: '6px', padding: '16px 20px', minWidth: '260px' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ color: 'var(--fg-bright)', fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>Delete Recipe</div>
            <div style={{ color: 'var(--fg)', fontSize: '12px', marginBottom: '14px' }}>
              Delete "{recipes.find(r => r.id === confirmDelete)?.name ?? confirmDelete}" permanently?
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDelete(null)}
                style={{ padding: '6px 14px', borderRadius: '3px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--fg-dim)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={() => doDelete(confirmDelete)}
                style={{ padding: '6px 14px', borderRadius: '3px', border: 'none', background: 'var(--red)', color: '#fff', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RecipeDetail({ recipe, ingredients, onEdit, onDelete }: { recipe: Recipe; ingredients: Ingredient[]; onEdit: () => void; onDelete: () => void }) {
  const mainTotal = recipe.lines.reduce((s, l) => s + l.target, 0);
  const ingName = (id: string) => ingredients.find(i => i.id === id)?.name ?? id;

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <div style={{ color: 'var(--fg-bright)', fontWeight: 500, fontSize: '13px' }}>{recipe.name}</div>
          <div style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>ID: {recipe.id} · Rev {recipe.revision} · Mix: {recipe.mixTime}s</div>
        </div>
        <div className="flex gap-2">
          <button onClick={onEdit} className="px-3 py-1.5 text-xs font-medium"
            style={{ background: 'transparent', color: 'var(--fg-bright)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>
            Edit
          </button>
          <button onClick={onDelete} className="px-3 py-1.5 text-xs font-medium"
            style={{ background: 'transparent', color: 'var(--red)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>
            Delete
          </button>
        </div>
      </div>

      {recipe.lines.length > 0 && (
        <table className="w-full" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--fg-dim)', fontSize: '12px' }}>
              <th className="text-left py-2 px-3" style={{ fontWeight: 600 }}>Ingredient</th>
              <th className="text-right py-2 px-3" style={{ fontWeight: 600 }}>Target</th>
              <th className="text-right py-2 px-3" style={{ fontWeight: 600 }}>%</th>
            </tr>
          </thead>
          <tbody>
            {recipe.lines.map(l => (
              <tr key={l.ingredientId} style={{ borderBottom: '1px solid var(--border)' }}>
                <td className="py-2 px-3" style={{ fontSize: '12px' }}>{ingName(l.ingredientId)}</td>
                <td className="text-right py-2 px-3" style={{ color: 'var(--fg-bright)', fontSize: '12px' }}>{l.target} {l.unit}</td>
                <td className="text-right py-2 px-3" style={{ color: 'var(--fg-dim)', fontSize: '12px' }}>{mainTotal > 0 ? (l.target / mainTotal * 100).toFixed(1) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {recipe.microLines.length > 0 && (
        <>
          <div style={{ color: 'var(--fg-bright)', fontSize: '12px', fontWeight: 600, letterSpacing: '0.03em' }}>MICRO</div>
          <table className="w-full" style={{ borderCollapse: 'collapse' }}>
            <tbody>
              {recipe.microLines.map(l => (
                <tr key={l.ingredientId} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td className="py-2 px-3" style={{ fontSize: '12px' }}>{ingName(l.ingredientId)}</td>
                  <td className="text-right py-2 px-3" style={{ color: 'var(--fg-bright)', fontSize: '12px' }}>{l.target} {l.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function RecipeEditor({ draft, setDraft, ingredients, onSave, onCancel }: {
  draft: Recipe;
  setDraft: (r: Recipe) => void;
  ingredients: Ingredient[];
  onSave: () => void;
  onCancel: () => void;
}) {
  const mainIngredients = ingredients.filter(i => i.category === 'MAIN');
  const microIngredients = ingredients.filter(i => i.category === 'MICRO');

  const inputStyle: React.CSSProperties = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--fg-bright)', padding: '4px 8px', fontFamily: 'inherit', fontSize: '12px' };

  function updateLine(section: 'lines' | 'microLines', idx: number, upd: Partial<RecipeLine>) {
    const arr = [...draft[section]];
    arr[idx] = { ...arr[idx], ...upd };
    setDraft({ ...draft, [section]: arr });
  }

  function addLine(section: 'lines' | 'microLines') {
    const pool = section === 'lines' ? mainIngredients : microIngredients;
    const used = new Set(draft[section].map(l => l.ingredientId));
    const next = pool.find(i => !used.has(i.id));
    if (!next) return;
    setDraft({ ...draft, [section]: [...draft[section], { ingredientId: next.id, target: 0, unit: next.unit }] });
  }

  function removeLine(section: 'lines' | 'microLines', idx: number) {
    setDraft({ ...draft, [section]: draft[section].filter((_, i) => i !== idx) });
  }

  const canSave = draft.id.trim() && draft.name.trim();

  return (
    <div className="p-3 flex flex-col gap-3" style={{ fontSize: '12px' }}>
      <div className="flex items-center justify-between">
        <span style={{ color: 'var(--fg-bright)', fontWeight: 600, fontSize: '13px' }}>{draft.revision === 0 ? 'New Recipe' : `Edit: ${draft.name}`}</span>
        <div className="flex gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs font-medium"
            style={{ background: 'transparent', color: 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={onSave} disabled={!canSave} className="px-3 py-1.5 text-xs font-medium"
            style={{ background: canSave ? 'var(--accent)' : 'var(--bg)', color: canSave ? '#000' : 'var(--fg-dim)', border: 'none', borderRadius: '3px', cursor: canSave ? 'pointer' : 'default' }}>
            Save
          </button>
        </div>
      </div>

      {/* Basic fields */}
      <div className="flex gap-3">
        <div className="flex flex-col gap-1" style={{ width: '100px' }}>
          <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>ID</span>
          <input value={draft.id} onChange={e => setDraft({ ...draft, id: e.target.value })} style={{ ...inputStyle, width: '100%' }} />
        </div>
        <div className="flex flex-col gap-1 flex-1">
          <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Name</span>
          <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} style={{ ...inputStyle, width: '100%' }} />
        </div>
        <div className="flex flex-col gap-1" style={{ width: '100px' }}>
          <span style={{ color: 'var(--fg-dim)', fontSize: '11px' }}>Mix Time (s)</span>
          <input type="number" value={draft.mixTime} onChange={e => setDraft({ ...draft, mixTime: Number(e.target.value) })} style={{ ...inputStyle, width: '100%' }} />
        </div>
      </div>

      {/* Main lines */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span style={{ color: 'var(--fg-bright)', fontSize: '12px', fontWeight: 600, letterSpacing: '0.03em' }}>MAIN INGREDIENTS</span>
          <button onClick={() => addLine('lines')} className="px-2 py-0.5 text-xs"
            disabled={mainIngredients.length === 0}
            style={{ color: 'var(--accent)', background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>
            + Add
          </button>
        </div>
        {draft.lines.length === 0 && <div style={{ color: 'var(--fg-dim)', fontSize: '12px', padding: '4px 0' }}>No ingredients added</div>}
        {draft.lines.map((line, i) => (
          <div key={i} className="flex items-center gap-2 mb-1">
            <select value={line.ingredientId} onChange={e => updateLine('lines', i, { ingredientId: e.target.value })} style={{ ...inputStyle, flex: 1 }}>
              {mainIngredients.map(ing => <option key={ing.id} value={ing.id}>{ing.name}</option>)}
            </select>
            <input type="number" value={line.target} onChange={e => updateLine('lines', i, { target: Number(e.target.value) })}
              style={{ ...inputStyle, width: '80px', textAlign: 'right' }} />
            <span style={{ color: 'var(--fg-dim)', width: '30px' }}>{line.unit}</span>
            <button onClick={() => removeLine('lines', i)}
              style={{ color: 'var(--red)', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '14px', lineHeight: 1 }}>×</button>
          </div>
        ))}
      </div>

      {/* Micro lines */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span style={{ color: 'var(--fg-bright)', fontSize: '12px', fontWeight: 600, letterSpacing: '0.03em' }}>MICRO INGREDIENTS</span>
          <button onClick={() => addLine('microLines')} className="px-2 py-0.5 text-xs"
            disabled={microIngredients.length === 0}
            style={{ color: 'var(--accent)', background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer' }}>
            + Add
          </button>
        </div>
        {draft.microLines.length === 0 && <div style={{ color: 'var(--fg-dim)', fontSize: '12px', padding: '4px 0' }}>No micro ingredients</div>}
        {draft.microLines.map((line, i) => (
          <div key={i} className="flex items-center gap-2 mb-1">
            <select value={line.ingredientId} onChange={e => updateLine('microLines', i, { ingredientId: e.target.value })} style={{ ...inputStyle, flex: 1 }}>
              {microIngredients.map(ing => <option key={ing.id} value={ing.id}>{ing.name}</option>)}
            </select>
            <input type="number" value={line.target} onChange={e => updateLine('microLines', i, { target: Number(e.target.value) })}
              style={{ ...inputStyle, width: '80px', textAlign: 'right' }} />
            <span style={{ color: 'var(--fg-dim)', width: '30px' }}>{line.unit}</span>
            <button onClick={() => removeLine('microLines', i)}
              style={{ color: 'var(--red)', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '14px', lineHeight: 1 }}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}
