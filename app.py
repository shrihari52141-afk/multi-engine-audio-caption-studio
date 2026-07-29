import streamlit as st
import streamlit.components.v1 as components
import os

st.set_page_config(
    page_title="Multi-Engine Dual-Pass Audio Caption Studio",
    page_icon="🎙️",
    layout="wide",
    initial_sidebar_state="collapsed"
)

# Hide Streamlit header padding for seamless integration
st.markdown("""
    <style>
        .block-container {
            padding-top: 0.5rem;
            padding-bottom: 0rem;
            padding-left: 0.5rem;
            padding-right: 0.5rem;
        }
        #MainMenu {visibility: hidden;}
        footer {visibility: hidden;}
    </style>
""", unsafe_allow_html=True)

# Load index.html
html_path = os.path.join(os.path.dirname(__file__), "index.html")
with open(html_path, "r", encoding="utf-8") as f:
    html_content = f.read()

# Render custom Web Audio & Caption Studio app inside Streamlit iframe
components.html(html_content, height=1400, scrolling=True)
