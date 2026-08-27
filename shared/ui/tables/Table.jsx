import React from 'react';

export function Table({ columns, data = [], onRowClick, className = '' }) {
	return (
		<div className={`overflow-x-auto ${className}`}>
			<table className="w-full text-left text-xs">
				<thead>
					<tr className="text-slate-400 border-b border-slate-100 uppercase tracking-wider text-[10px]">
						{columns.map((col) => (
							<th key={col.key || col.label} className="pb-3 font-bold">
								{col.label}
							</th>
						))}
					</tr>
				</thead>
				<tbody className="divide-y divide-slate-100">
					{data.map((row, ri) => (
						<tr
							key={ri}
							onClick={() => onRowClick && onRowClick(row)}
							className={`transition-colors duration-150 ${onRowClick ? 'cursor-pointer hover:bg-slate-50/90' : 'hover:bg-slate-50/70'}`}>
							{columns.map((col) => (
								<td key={col.key || col.label} className="py-3.5 text-xs text-slate-700">
									{col.render ? col.render(row[col.key], row) : row[col.key]}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export const DataTable = Table;
