import React, { useState } from 'react';
import './UploadArea.css';

interface UploadAreaProps {
    onUpload: (file: File) => void;
}

function UploadArea({ onUpload }: UploadAreaProps) {
    const [isDragover, setIsDragover] = useState(false);

    const handleDragover = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragover(true);
    };

    const handleDragleave = () => {
        setIsDragover(false);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragover(false);

        const file = e.dataTransfer.files[0];
        if (file && isValidFile(file)) {
            onUpload(file);
        }
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file && isValidFile(file)) {
            onUpload(file);
        }
    };

    const isValidFile = (file: File): boolean => {
        const validTypes = ['image/png', 'image/jpeg', 'application/pdf'];
        return validTypes.includes(file.type);
    };

    return (
        <div
            className={`upload-area ${isDragover ? 'dragover' : ''}`}
            onDragOver={handleDragover}
            onDragLeave={handleDragleave}
            onDrop={handleDrop}
        >
            <div className="upload-content">
                <div className="upload-icon">📤</div>
                <h2>Upload Floor Plan</h2>
                <p>Drag and drop your floor plan (PNG, JPEG, or PDF)</p>

                <label className="file-input-label">
                    <input
                        type="file"
                        accept=".png,.jpg,.jpeg,.pdf"
                        onChange={handleFileSelect}
                        style={{ display: 'none' }}
                    />
                    <span className="file-input-button">Select File</span>
                </label>
            </div>
        </div>
    );
}

export default UploadArea;
