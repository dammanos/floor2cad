from setuptools import setup, find_packages

setup(
    name="floor2cad",
    version="0.1.0",
    description="Convert Matterport floorplan PNGs into DXF CAD files via Canny edge detection",
    author="Your Name",
    author_email="you@example.com",
    url="https://github.com/yourusername/floor2cad",
    packages=find_packages(),
    include_package_data=True,
    install_requires=[
        "opencv-python",
        "ezdxf",
        "numpy"
    ],
    entry_points={
        "console_scripts": [
            "floor2cad=floor2cad.convert_to_dxf:main"
        ]
    },
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
    ],
    python_requires='>=3.7',
)
