import React, { useState } from 'react';

export function Tooltip({ text, children, position = 'top' }) {
	const [visible, setVisible] = useState(false);

	const positionStyles = {
		top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
		bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
		left: 'right-full top-1/2 -translate-y-1/2 mr-2',
		right: 'left-full top-1/2 -translate-y-1/2 ml-2',
	};

	return (
		<div className="relative inline-flex" onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}>
			{children}
			{visible && (
				<div
					className={`absolute z-50 px-2.5 py-1 text-[11px] font-medium text-white bg-zinc-950 rounded-lg shadow-lg whitespace-nowrap pointer-events-none ${
						positionStyles[position] || positionStyles.top
					}`}>
					{text}
				</div>
			)}
		</div>
	);
}
